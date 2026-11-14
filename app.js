(function () {
  "use strict";
  const VAR_CATS = ["食費", "日用品", "交通", "趣味・娯楽", "交際", "学業", "衣服", "その他"];
  const FIXED_CATS = ["サブスク", "通信", "その他"];
  const CSV = window.KakeiboCSV;
  const DEMO = !!window.KAKEIBO_DEMO;
  const $ = (id) => document.getElementById(id);
  const yen = (n) => (n < 0 ? "-¥" : "¥") + Math.abs(Math.round(n)).toLocaleString("ja-JP");
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const todayStr = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const data = { version: 1, fixed: [], expenses: [], budget: null, lastBackup: null, hideRules: ["DMM"], rulesApplied: 0 };
  const ui = { ym: todayStr.slice(0, 7), cat: "食費", editingFixed: null, addingFixed: false, editorKey: undefined, editorEl: null, imp: null, peek: false };

  // 店名・メモにこの文字列が入っているものは、記録した時点で「一覧に表示しない」にする
  function matchesHideRule(text) {
    const t = CSV.norm(text || "");
    return (data.hideRules || []).some((r) => r && t.indexOf(CSV.norm(r)) > -1);
  }
  const visible = (x) => ui.peek || !x.hidden;

  // ---------- storage (IndexedDB, localStorage fallback; memory only in the demo) ----------
  let idb = null, storageMode = "none";
  function openIDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("kakeibo", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function idbGet(key) {
    return new Promise((res, rej) => {
      const t = idb.transaction("kv", "readonly").objectStore("kv").get(key);
      t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
    });
  }
  function idbPut(key, val) {
    return new Promise((res, rej) => {
      const tx = idb.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  }
  async function load() {
    if (DEMO) { storageMode = "memory"; Object.assign(data, window.KAKEIBO_DEMO_DATA || {}); return; }
    try { idb = await openIDB(); const v = await idbGet("state"); storageMode = "idb"; if (v) Object.assign(data, v); return; } catch (e) { idb = null; }
    try { const v = localStorage.getItem("kakeibo-state"); storageMode = "ls"; if (v) Object.assign(data, JSON.parse(v)); } catch (e) { storageMode = "none"; }
  }
  async function save() {
    if (storageMode === "memory") return true;
    const snap = JSON.parse(JSON.stringify(data));
    try {
      if (storageMode === "idb") await idbPut("state", snap);
      else if (storageMode === "ls") localStorage.setItem("kakeibo-state", JSON.stringify(snap));
      else throw new Error("no storage");
      return true;
    } catch (e) {
      setStatus("保存できませんでした。スマホの空き容量を確認してください。");
      return false;
    }
  }

  // ---------- helpers ----------
  function shiftMonth(ym, d) {
    let [y, m] = ym.split("-").map(Number);
    m += d; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; }
    return y + "-" + pad(m);
  }
  const monthLabel = (ym) => { const [y, m] = ym.split("-"); return y + "年" + Number(m) + "月"; };
  const activeIn = (f, ym) => (!f.start || f.start <= ym) && (!f.end || ym <= f.end);
  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    }
    if (text != null) e.textContent = text;
    return e;
  }
  function setStatus(msg) { const s = $("status"); s.textContent = msg || ""; s.hidden = !msg; }
  function flash(node, msg, isErr) {
    node.textContent = msg; node.className = "msg" + (isErr ? " err" : "");
    clearTimeout(node._t); if (!isErr) node._t = setTimeout(() => { node.textContent = ""; }, 3500);
  }
  function armConfirm(btn, label, action) {
    if (btn.dataset.armed) { action(); return; }
    btn.dataset.armed = "1"; const orig = btn.textContent; btn.textContent = label;
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = orig; } }, 3000);
  }
  function catSelect(value, id) {
    const s = el("select", id ? { id } : null);
    VAR_CATS.forEach((c) => { const o = el("option", { value: c }, c); if (c === value) o.selected = true; s.append(o); });
    return s;
  }
  function download(filename, text) {
    if (DEMO) return false;
    const blob = new Blob([text], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  }

  // ---------- popups ----------
  function openSheet(id) {
    const d = $(id);
    if (d.open) return;
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    const body = d.querySelector(".sheet-body"); if (body) body.scrollTop = 0;
  }
  function closeSheet(d) {
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  }
  document.querySelectorAll("dialog.sheet").forEach((d) => {
    d.querySelector("[data-close]").addEventListener("click", () => closeSheet(d));
    // tap on the dimmed area outside the box closes it
    d.addEventListener("click", (ev) => {
      if (ev.target !== d) return;
      const r = d.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) closeSheet(d);
    });
    d.addEventListener("close", () => {
      if (d.id === "dlgFixed") { ui.editingFixed = null; ui.addingFixed = false; }
      if (d.id === "dlgFixed" || d.id === "dlgVar") ui.peek = false; // 閉じたら隠した項目はまた見えなくなる
      if (d.id === "dlgImp") ui.imp = null;
      render();
    });
  });
  // ポップアップの見出しを長押しすると、隠した項目の表示を切り替える（見た目の印は何もない）
  function togglePeek() {
    ui.peek = !ui.peek;
    if (!ui.peek) { const f = data.fixed.find((x) => x.id === ui.editingFixed); if (f && f.hidden) ui.editingFixed = null; }
    try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
    render();
  }
  document.querySelectorAll("[data-hold]").forEach((h) => {
    let timer = null, sx = 0, sy = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    h.addEventListener("pointerdown", (ev) => { sx = ev.clientX; sy = ev.clientY; cancel(); timer = setTimeout(() => { timer = null; togglePeek(); }, 600); });
    h.addEventListener("pointermove", (ev) => { if (timer && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) cancel(); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((t) => h.addEventListener(t, cancel));
    h.addEventListener("contextmenu", (ev) => ev.preventDefault());
  });
  async function setHidden(x, hidden) { x.hidden = hidden; await save(); render(); }
  $("openCats").addEventListener("click", () => openSheet("dlgCats"));
  $("openVar").addEventListener("click", () => openSheet("dlgVar"));
  $("openFixed").addEventListener("click", () => openSheet("dlgFixed"));

  // ---------- render ----------
  function render() {
    const ym = ui.ym;
    $("monthLabel").textContent = monthLabel(ym);
    const fixedNow = data.fixed.filter((f) => activeIn(f, ym));
    const exps = data.expenses.filter((x) => x.date && x.date.slice(0, 7) === ym);
    const sumFixed = fixedNow.reduce((a, f) => a + (Number(f.amount) || 0), 0);
    const sumVar = exps.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const total = sumFixed + sumVar;

    const t = $("total"); t.textContent = ""; t.append(el("small", null, total < 0 ? "-¥" : "¥"), document.createTextNode(Math.abs(Math.round(total)).toLocaleString("ja-JP")));
    const budget = Number(data.budget) > 0 ? Number(data.budget) : null;
    const scale = Math.max(total, budget || 0) || 1;
    $("barFixed").style.width = Math.max(0, sumFixed / scale * 100) + "%";
    $("barVar").style.width = Math.max(0, sumVar / scale * 100) + "%";
    $("budgetVal").textContent = budget ? yen(budget) : "未設定";
    const rest = $("budgetRest");
    if (budget) { const r = budget - total; rest.textContent = r >= 0 ? "残り " + yen(r) : yen(-r) + " オーバー"; rest.className = "rest" + (r < 0 ? " over" : ""); }
    else rest.textContent = "";
    $("budgetEdit").textContent = budget ? "変更" : "予算を設定";

    // tiles: 金額は隠した項目も含めた合計、件数は見えている項目だけ
    const expsShown = exps.filter(visible);
    $("sumVar").textContent = yen(sumVar);
    $("varCount").textContent = exps.filter((x) => !x.hidden).length + "件";
    $("sumFixed").textContent = yen(sumFixed);
    $("fixedCount").textContent = fixedNow.filter((f) => !f.hidden).length + "件";

    const chips = $("catChips"); chips.textContent = "";
    VAR_CATS.forEach((c) => {
      const b = el("button", { type: "button", "aria-pressed": String(ui.cat === c) }, c);
      b.addEventListener("click", () => { ui.cat = c; render(); });
      chips.append(b);
    });

    // category popup
    $("dlgCatsSub").textContent = monthLabel(ym) + "・合計 " + yen(total);
    const byCat = {};
    exps.forEach((x) => { const c = x.category || "その他"; byCat[c] = (byCat[c] || 0) + (Number(x.amount) || 0); });
    const rows = [];
    if (sumFixed) rows.push({ name: "固定費", amt: sumFixed, color: "var(--fixed)" });
    Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).forEach((c) => rows.push({ name: c, amt: byCat[c], color: "var(--var)" }));
    const cats = $("cats"); cats.textContent = "";
    if (!rows.length) cats.append(el("p", { class: "empty" }, "この月の支出はまだありません。"));
    const maxAmt = Math.max(1, ...rows.map((r) => r.amt));
    rows.forEach((r) => {
      const row = el("div", { class: "cat" });
      const track = el("div", { class: "track" });
      track.append(el("span", { style: "width:" + Math.max(0, r.amt / maxAmt * 100) + "%;background:" + r.color }));
      row.append(el("span", null, r.name), track, el("span", { class: "amt" }, yen(r.amt)));
      cats.append(row);
    });

    // variable-cost popup
    $("dlgVarSub").textContent = monthLabel(ym) + "・" + expsShown.length + "件・" + yen(sumVar);
    const list = $("expList"); list.textContent = "";
    if (!expsShown.length) list.append(el("p", { class: "empty" }, "この月の記録はまだありません。"));
    const byDay = {};
    expsShown.forEach((x) => { (byDay[x.date] = byDay[x.date] || []).push(x); });
    Object.keys(byDay).sort().reverse().forEach((d) => {
      const items = byDay[d].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const wd = "日月火水木金土"[new Date(d + "T00:00:00").getDay()];
      const head = el("div", { class: "day" });
      head.append(el("span", null, Number(d.slice(5, 7)) + "月" + Number(d.slice(8)) + "日（" + wd + "）"),
        el("span", { class: "num" }, yen(items.reduce((a, x) => a + (Number(x.amount) || 0), 0))));
      list.append(head);
      items.forEach((x) => {
        const it = el("div", { class: "item" + (x.hidden ? " is-hidden" : "") });
        const main = el("div", { class: "main" });
        const nm = el("div", { class: "name" });
        const sel = catSelect(x.category || "その他");
        sel.className = "tag"; sel.setAttribute("aria-label", "カテゴリを変更");
        sel.addEventListener("change", async () => { x.category = sel.value; await save(); render(); });
        nm.append(sel, document.createTextNode(" " + (x.memo || "")));
        if (x.hidden) nm.append(el("span", { class: "hid-tag" }, "非表示"));
        main.append(nm);
        if (x.source) main.append(el("div", { class: "sub" }, "明細から取り込み"));
        const acts = el("div", { class: "acts" });
        // 隠した項目を目のボタンで出しているときだけ、元に戻すボタンを出す
        if (x.hidden) {
          const unhide = el("button", { class: "ghost", type: "button" }, "表示に戻す");
          unhide.addEventListener("click", () => setHidden(x, false));
          acts.append(unhide);
        }
        const del = el("button", { class: "ghost danger", type: "button", "aria-label": "この支出を削除" }, "削除");
        del.addEventListener("click", () => armConfirm(del, "削除する", async () => {
          data.expenses = data.expenses.filter((e) => e.id !== x.id); await save(); render();
        }));
        acts.append(del);
        it.append(main, el("span", { class: "amt" }, yen(x.amount)), acts);
        list.append(it);
      });
    });

    // fixed-cost popup
    $("dlgFixedSub").textContent = monthLabel(ym) + "・" + fixedNow.filter(visible).length + "件";
    $("fixedAdd").disabled = ui.addingFixed;
    const editKey = ui.addingFixed ? "new" : ui.editingFixed;
    const cacheKey = editKey ? editKey + "|" + ui.peek : null;
    if (cacheKey !== ui.editorKey) {
      ui.editorKey = cacheKey;
      ui.editorEl = editKey ? fixedEditor(editKey === "new" ? null : data.fixed.find((x) => x.id === editKey) || null) : null;
    }
    const nw = $("fixedNew"); nw.textContent = "";
    if (ui.addingFixed && ui.editorEl) nw.append(ui.editorEl);
    const fl = $("fixedList"); fl.textContent = "";
    if (!data.fixed.length) fl.append(el("p", { class: "empty" }, "毎月払うサブスクや通信費を追加すると、毎月の合計に自動で入ります。"));
    data.fixed.filter(visible).sort((a, b) => (activeIn(b, ym) - activeIn(a, ym)) || (Number(b.amount) - Number(a.amount))).forEach((f) => {
      if (ui.editingFixed === f.id && ui.editorEl) { fl.append(ui.editorEl); return; }
      const on = activeIn(f, ym);
      const it = el("div", { class: "item" + (f.hidden ? " is-hidden" : "") }); if (!on) it.style.opacity = ".5";
      const main = el("div", { class: "main" });
      const nm = el("div", { class: "name" });
      nm.append(el("span", { class: "tag" }, f.category || "その他"), document.createTextNode(f.name || ""));
      if (f.hidden) nm.append(el("span", { class: "hid-tag" }, "非表示"));
      const sub = [f.day ? "毎月" + f.day + "日 引き落とし" : "引き落とし日 未登録"];
      if (f.note) sub.push(f.note);
      if (f.end) sub.push(monthLabel(f.end) + "まで");
      else if (f.start && f.start > ym) sub.push(monthLabel(f.start) + "から");
      main.append(nm, el("div", { class: "sub" }, sub.join(" ・ ")));
      const ed = el("button", { class: "ghost", type: "button" }, "編集");
      ed.addEventListener("click", () => { ui.editingFixed = f.id; ui.addingFixed = false; render(); });
      it.append(main, el("span", { class: "amt" }, yen(f.amount)), ed);
      fl.append(it);
    });
    $("fixedMonth").textContent = yen(sumFixed);
    $("fixedYear").textContent = yen(sumFixed * 12);

    // backup warning: shown only when a backup is overdue
    const warn = $("backupWarn");
    const oldest = data.expenses.concat(data.fixed).reduce((a, x) => Math.min(a, x.createdAt || Infinity), Infinity);
    const since = data.lastBackup || (isFinite(oldest) ? oldest : null);
    const days = since ? Math.floor((Date.now() - since) / 864e5) : 0;
    warn.hidden = DEMO || days < 30;
    if (!warn.hidden) warn.textContent = data.lastBackup ? "最後のバックアップから" + days + "日たっています。" : "まだバックアップしていません。";
  }

  function fixedEditor(f) {
    const box = el("form", { class: "edit-box" });
    const k = f ? f.id : "new";
    const mk = (label, input) => { const w = el("div", { class: "field" }); w.append(el("label", { for: input.id }, label), input); return w; };
    const name = el("input", { id: "fxName-" + k, type: "text", maxlength: "40", required: "" }); name.value = f ? f.name || "" : "";
    const amount = el("input", { id: "fxAmt-" + k, type: "number", class: "amount", min: "0", step: "1", inputmode: "numeric", required: "" }); amount.value = f ? f.amount : "";
    const day = el("input", { id: "fxDay-" + k, type: "number", min: "1", max: "31", step: "1", inputmode: "numeric", placeholder: "例 27" }); day.value = f && f.day ? f.day : "";
    const cat = el("select", { id: "fxCat-" + k });
    FIXED_CATS.forEach((c) => { const o = el("option", { value: c }, c); if ((f ? f.category : "サブスク") === c) o.selected = true; cat.append(o); });
    const note = el("input", { id: "fxNote-" + k, type: "text", maxlength: "60", placeholder: "プラン名など" }); note.value = f && f.note ? f.note : "";
    const r1 = el("div", { class: "row2" }); r1.append(mk("金額（円/月）", amount), mk("引き落とし日", day));
    const r2 = el("div", { class: "row2" }); r2.append(mk("種類", cat), mk("メモ", note));
    const hidBox = el("input", { type: "checkbox", id: "fxHid-" + k }); hidBox.checked = !!(f && f.hidden);
    const hidLbl = el("label", { class: "check", for: "fxHid-" + k }); hidLbl.append(hidBox, document.createTextNode("一覧に表示しない"));
    const err = el("div", { class: "msg err", role: "status" });
    const acts = el("div", { class: "actions" });
    const close = () => { ui.editingFixed = null; ui.addingFixed = false; render(); };
    if (f) {
      if (!f.end) {
        const stop = el("button", { type: "button", class: "danger" }, "解約した");
        stop.addEventListener("click", () => armConfirm(stop, monthLabel(ui.ym) + "から外す", async () => { f.end = shiftMonth(ui.ym, -1); await save(); close(); }));
        acts.append(stop);
      } else {
        const resume = el("button", { type: "button" }, "再開する");
        resume.addEventListener("click", async () => { f.end = null; await save(); close(); });
        acts.append(resume);
      }
      const del = el("button", { type: "button", class: "ghost danger" }, "完全に削除");
      del.addEventListener("click", () => armConfirm(del, "過去の月からも消す", async () => { data.fixed = data.fixed.filter((x) => x.id !== f.id); await save(); close(); }));
      acts.append(del);
    }
    const cancel = el("button", { type: "button", class: "ghost" }, "やめる");
    cancel.addEventListener("click", close);
    acts.append(cancel, el("button", { type: "submit", class: "primary" }, f ? "保存" : "追加"));
    box.append(mk("サービス名", name), r1, r2);
    if (ui.peek) box.append(hidLbl); // 隠す設定は、目のボタンで隠した項目を出しているときだけ出す
    box.append(err, acts);
    box.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const a = Math.round(Number(amount.value));
      const d = day.value ? Math.round(Number(day.value)) : null;
      if (!name.value.trim()) { err.textContent = "サービス名を入れてください。"; return; }
      if (!(a >= 0)) { err.textContent = "金額を0以上の数字で入れてください。"; return; }
      if (d != null && (d < 1 || d > 31)) { err.textContent = "引き落とし日は1〜31で入れてください。"; return; }
      const body = { name: name.value.trim(), amount: a, day: d, category: cat.value, note: note.value.trim(), hidden: hidBox.checked };
      if (f) Object.assign(f, body);
      else {
        if (matchesHideRule(body.name)) body.hidden = true;
        data.fixed.push(Object.assign(body, { id: uid(), start: ui.ym, end: null, createdAt: Date.now() }));
      }
      await save(); close();
    });
    setTimeout(() => { try { name.focus(); } catch (e) {} }, 0);
    return box;
  }

  // ---------- events ----------
  $("prevMonth").addEventListener("click", () => { ui.ym = shiftMonth(ui.ym, -1); ui.editingFixed = null; render(); });
  $("nextMonth").addEventListener("click", () => { ui.ym = shiftMonth(ui.ym, 1); ui.editingFixed = null; render(); });
  $("fixedAdd").addEventListener("click", () => { ui.addingFixed = true; ui.editingFixed = null; render(); });
  $("budgetEdit").addEventListener("click", () => { $("budgetInput").value = data.budget || ""; $("budgetView").hidden = true; $("budgetForm").hidden = false; $("budgetInput").focus(); });
  $("budgetCancel").addEventListener("click", () => { $("budgetView").hidden = false; $("budgetForm").hidden = true; });
  $("budgetForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = $("budgetInput").value === "" ? null : Math.max(0, Math.round(Number($("budgetInput").value)));
    data.budget = v; await save();
    $("budgetView").hidden = false; $("budgetForm").hidden = true; render();
  });
  $("expDate").value = todayStr;
  $("expForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = Math.round(Number($("expAmount").value)), d = $("expDate").value;
    if (!a) { flash($("expMsg"), "金額を入れてください。返金はマイナスで入れられます。", true); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { flash($("expMsg"), "日付を選んでください。", true); return; }
    const memo = $("expMemo").value.trim();
    data.expenses.push({ id: uid(), amount: a, date: d, category: ui.cat, memo, hidden: matchesHideRule(memo), createdAt: Date.now() });
    if (await save()) {
      $("expAmount").value = ""; $("expMemo").value = "";
      if (d.slice(0, 7) !== ui.ym) ui.ym = d.slice(0, 7);
      render(); flash($("expMsg"), yen(a) + "（" + ui.cat + "）を記録しました。");
    }
  });

  // ---------- backup ----------
  $("exportBtn").addEventListener("click", async () => {
    if (DEMO) { flash($("dataMsg"), "デモ版では書き出しません。"); return; }
    data.lastBackup = Date.now(); await save();
    download("kakeibo-backup-" + todayStr + ".json", JSON.stringify(Object.assign({ app: "kakeibo" }, data), null, 1));
    flash($("dataMsg"), "書き出しました。ダウンロードフォルダに保存されています。"); render();
  });
  $("importFile").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0]; ev.target.value = "";
    if (!file) return;
    let incoming;
    try { incoming = JSON.parse(await file.text()); } catch (e) { flash($("dataMsg"), "このファイルは読み込めません。書き出したバックアップ（.json）を選んでください。", true); return; }
    if (!incoming || incoming.app !== "kakeibo" || !Array.isArray(incoming.fixed) || !Array.isArray(incoming.expenses)) {
      flash($("dataMsg"), "家計簿のバックアップではないようです。書き出したファイルを選んでください。", true); return;
    }
    const haveF = new Set(data.fixed.map((x) => x.id)), haveE = new Set(data.expenses.map((x) => x.id));
    const nf = incoming.fixed.filter((x) => x && x.id && !haveF.has(x.id));
    const ne = incoming.expenses.filter((x) => x && x.id && !haveE.has(x.id));
    nf.forEach((f) => { if (f.hidden == null && matchesHideRule(f.name)) f.hidden = true; });
    ne.forEach((x) => { if (x.hidden == null && matchesHideRule(x.memo)) x.hidden = true; });
    data.fixed.push(...nf); data.expenses.push(...ne);
    if (data.budget == null && incoming.budget != null) data.budget = incoming.budget;
    await save(); render();
    flash($("dataMsg"), "固定費" + nf.length + "件、支出" + ne.length + "件を追加しました。");
  });

  // ---------- CSV import ----------
  function fillSelect(sel, labels, value) {
    sel.textContent = "";
    labels.forEach((l, i) => { const o = el("option", { value: String(i) }, l); if (i === value) o.selected = true; sel.append(o); });
  }
  function existingKeys() { return data.expenses.map((x) => x.key || CSV.entryKey(x.date, x.amount, x.memo || "")); }
  function rebuildCandidates() {
    const imp = ui.imp;
    const active = data.fixed.filter((f) => !f.end);
    imp.cands = CSV.buildCandidates(imp.analysis, imp.map, { existingKeys: existingKeys(), fixedNames: active.map((f) => f.name), fixed: active });
    imp.cands.forEach((c) => { c.hidden = matchesHideRule(c.desc); });
    renderImport();
  }
  function renderImport() {
    const imp = ui.imp;
    if (!imp) return;
    const m = imp.map, labels = imp.analysis.labels;
    $("impKind").value = m.kind;
    fillSelect($("impDate"), labels, m.date);
    fillSelect($("impDesc"), labels, m.desc);
    fillSelect($("impAmount"), labels, m.amount);
    fillSelect($("impOut"), labels, m.out);
    $("impAmountWrap").hidden = m.kind !== "card";
    $("impOutWrap").hidden = m.kind !== "bank";
    const list = $("impList"); list.textContent = "";
    if (!imp.cands.length) list.append(el("p", { class: "empty" }, "取り込める行が見つかりませんでした。列の選び方を変えてみてください。"));
    imp.cands.forEach((c, i) => {
      const row = el("div", { class: "imp-row" + (c.checked ? "" : " off") });
      const cb = el("input", { type: "checkbox", id: "impc-" + i, "aria-label": c.desc + "を取り込む" }); cb.checked = c.checked;
      cb.addEventListener("change", () => { c.checked = cb.checked; row.className = "imp-row" + (c.checked ? "" : " off"); updateCount(); });
      const main = el("div", { class: "main" });
      main.append(el("label", { class: "desc", for: "impc-" + i }, c.desc || "（内容なし）"));
      const meta = el("div", { class: "meta" });
      const sel = catSelect(c.category); sel.setAttribute("aria-label", "カテゴリ");
      sel.addEventListener("change", () => { c.category = sel.value; });
      const hb = el("input", { type: "checkbox", id: "imph-" + i }); hb.checked = !!c.hidden;
      hb.addEventListener("change", () => { c.hidden = hb.checked; });
      const hl = el("label", { class: "check", for: "imph-" + i }); hl.append(hb, document.createTextNode("隠す"));
      meta.append(el("span", { class: "num" }, c.date.slice(5).replace("-", "/")), sel, hl);
      main.append(meta);
      if (c.note) main.append(el("span", { class: "note" }, c.note));
      row.append(cb, main, el("span", { class: "amt" }, yen(c.amount)));
      list.append(row);
    });
    updateCount();
  }
  function updateCount() {
    const sel = ui.imp.cands.filter((c) => c.checked);
    $("impCount").textContent = sel.length + "件・" + yen(sel.reduce((a, c) => a + c.amount, 0));
    $("impGo").disabled = !sel.length;
  }
  $("csvFile").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0]; ev.target.value = "";
    if (!file) return;
    try {
      const { text, encoding } = CSV.decode(await file.arrayBuffer());
      const analysis = CSV.analyze(CSV.parseCSV(text));
      if (!analysis.rows.length) { flash($("impResult"), "日付の入った行が見つかりませんでした。明細のCSVか確認してください。", true); return; }
      flash($("impResult"), "");
      ui.imp = { file: file.name, analysis, map: Object.assign({}, analysis.map), cands: [] };
      $("impInfo").textContent = file.name + "・" + encoding + "・" + analysis.rows.length + "行";
      rebuildCandidates();
      openSheet("dlgImp");
    } catch (e) {
      flash($("impResult"), "ファイルを読み込めませんでした。CSVファイルか確認してください。", true);
    }
  });
  const onMap = (key, sel) => sel.addEventListener("change", () => { ui.imp.map[key] = Number(sel.value); rebuildCandidates(); });
  onMap("date", $("impDate")); onMap("desc", $("impDesc")); onMap("amount", $("impAmount")); onMap("out", $("impOut"));
  $("impKind").addEventListener("change", () => {
    const m = ui.imp.map; m.kind = $("impKind").value;
    if (m.kind === "bank" && m.out === -1) m.out = m.amount;
    if (m.kind === "card" && m.amount === -1) m.amount = m.out;
    rebuildCandidates();
  });
  $("impGo").addEventListener("click", async () => {
    const sel = ui.imp.cands.filter((c) => c.checked);
    const t = Date.now();
    sel.forEach((c, i) => data.expenses.push({ id: uid(), amount: c.amount, date: c.date, category: c.category, memo: c.desc.normalize("NFKC"), hidden: !!c.hidden, createdAt: t + i, source: "csv", key: c.key }));
    if (await save()) {
      const months = Array.from(new Set(sel.map((c) => c.date.slice(0, 7)))).sort();
      if (months.length) ui.ym = months[months.length - 1];
      closeSheet($("dlgImp")); render();
      flash($("impResult"), sel.length + "件・" + yen(sel.reduce((a, c) => a + c.amount, 0)) + "を取り込みました。");
    }
  });

  // ---------- start ----------
  $("demoNote").hidden = !DEMO;
  render();
  (async () => {
    await load();
    // すでに記録してある分にも、一度だけ隠すルールを当てる
    if (!data.rulesApplied) {
      data.expenses.forEach((x) => { if (matchesHideRule(x.memo)) x.hidden = true; });
      data.fixed.forEach((f) => { if (matchesHideRule(f.name)) f.hidden = true; });
      data.rulesApplied = 1; await save();
    }
    if (storageMode === "none") setStatus("このブラウザでは保存できないため、閉じると記録が消えます。");
    else if (storageMode === "ls") setStatus("簡易保存モードで動いています。こまめにバックアップしてください。");
    if (!DEMO) { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {} }
    render();
  })();

  if (!DEMO && "serviceWorker" in navigator) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }
})();
