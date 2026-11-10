/* 明細CSVの読み込み・列の判別・取り込み候補の作成 */
(function (root) {
  "use strict";

  // ---- 文字コード ----
  function decode(buf) {
    const bytes = new Uint8Array(buf);
    try {
      let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return { text, encoding: "UTF-8" };
    } catch (e) {
      return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "Shift_JIS" };
    }
  }

  // ---- CSV ----
  function parseCSV(text) {
    const rows = []; let row = []; let cell = ""; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((s) => s.trim())).filter((r) => r.some((s) => s !== ""));
  }

  const norm = (s) => String(s == null ? "" : s).normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();

  // ---- 日付 ----
  const pad = (n) => String(n).padStart(2, "0");
  function validYMD(y, m, d) {
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) return null;
    return y + "-" + pad(m) + "-" + pad(d);
  }
  function parseDate(raw, today) {
    const s = norm(raw).replace(/\s/g, "");
    if (!s) return null;
    today = today || new Date();
    let m;
    // 令和 R6.1.5 / 令和6年1月5日
    if ((m = s.match(/^(?:R|令和)(\d{1,2})[.\/年-](\d{1,2})[.\/月-](\d{1,2})日?$/))) return validYMD(2018 + Number(m[1]), +m[2], +m[3]);
    if ((m = s.match(/^(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})日?/))) return validYMD(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return validYMD(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/))) return validYMD(2000 + Number(m[1]), +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[\/月](\d{1,2})日?$/))) {
      let y = today.getFullYear();
      let r = validYMD(y, +m[1], +m[2]);
      if (r && new Date(r) - today > 31 * 864e5) r = validYMD(y - 1, +m[1], +m[2]);
      return r;
    }
    return null;
  }

  // ---- 金額 ----
  function parseAmount(raw) {
    let s = norm(raw).replace(/[,¥\\円\s]/g, "").replace(/^\((.*)\)$/, "-$1");
    if (s === "" || s === "-") return null;
    if (/^[▲△]/.test(s)) s = "-" + s.slice(1);
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Math.round(Number(s));
  }

  // ---- 列の判別 ----
  const H = {
    date: /(日付|年月日|利用日|取引日|ご利用日|お取引日|取扱日|DATE)/,
    desc: /(利用店|ご利用先|利用先|店名|内容|摘要|商品|お取り?扱い?内容|取引内容|DESCRIPTION)/,
    amount: /(利用金額|ご利用金額|金額|AMOUNT)/,
    out: /(お?引出し?|出金|お?支払い?金額|支払|払出)/,
    in: /(お?預入れ?|入金|預かり金額|お?預り|受入)/,
    balance: /(残高)/,
  };

  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i].map(norm);
      const hasDate = r.some((c) => H.date.test(c) && c.length <= 12);
      const hasMoney = r.some((c) => (H.amount.test(c) || H.out.test(c) || H.in.test(c)) && c.length <= 14);
      if (hasDate && hasMoney) return i;
    }
    return -1;
  }

  function pick(headers, re, exclude) {
    for (let i = 0; i < headers.length; i++) {
      if (exclude && exclude.indexOf(i) > -1) continue;
      if (re.test(headers[i])) return i;
    }
    return -1;
  }

  function analyze(rows, today) {
    const width = rows.reduce((a, r) => Math.max(a, r.length), 0);
    const h = findHeader(rows);
    let headers, body, map = { kind: "card", date: -1, desc: -1, desc2: -1, amount: -1, out: -1, in: -1 };
    if (h > -1) {
      headers = rows[h].map(norm);
      body = rows.slice(h + 1);
      map.date = pick(headers, H.date);
      const outCol = pick(headers, H.out, [map.date]);
      const inCol = pick(headers, H.in, [map.date]);
      const hasBal = pick(headers, H.balance) > -1;
      const amt = pick(headers, H.amount, [map.date]);
      if (inCol > -1 && outCol > -1 && (hasBal || amt === -1 || amt === outCol)) {
        map.kind = "bank"; map.out = outCol; map.in = inCol;
      } else {
        map.amount = amt > -1 ? amt : outCol;
      }
      // 内容は「摘要内容」など説明の長い列を優先
      map.desc = pick(headers, /(摘要内容|利用店名|ご利用先|店名|商品)/, [map.date]);
      if (map.desc === -1) map.desc = pick(headers, H.desc, [map.date, map.amount, map.out, map.in]);
      const short = headers.indexOf("摘要");
      if (short > -1 && short !== map.desc) map.desc2 = short;
    } else {
      headers = [];
      body = rows;
    }

    const data = body.filter((r) => r.some((c) => parseDate(c, today)));
    // ヘッダーがない／足りない場合は中身から推定
    const score = (fn) => { const s = []; for (let c = 0; c < width; c++) s[c] = data.reduce((a, r) => a + (fn(r[c]) ? 1 : 0), 0); return s; };
    if (map.date === -1) {
      const s = score((v) => parseDate(v, today));
      map.date = s.indexOf(Math.max(...s));
    }
    const numeric = score((v) => parseAmount(v) !== null && !parseDate(v, today));
    const texty = score((v) => v && parseAmount(v) === null && !parseDate(v, today));
    if (map.desc === -1) {
      let best = -1, bv = 0;
      for (let c = 0; c < width; c++) if (c !== map.date && texty[c] > bv) { bv = texty[c]; best = c; }
      map.desc = best;
    }
    if (map.kind === "card" && map.amount === -1) {
      const start = Math.max(map.date, map.desc) + 1;
      for (let c = start; c < width; c++) if (numeric[c] >= data.length * 0.6) { map.amount = c; break; }
      if (map.amount === -1) for (let c = 0; c < width; c++) if (c !== map.date && numeric[c] >= data.length * 0.6) { map.amount = c; break; }
    }
    const labels = [];
    for (let c = 0; c < width; c++) {
      const sample = (data[0] && data[0][c]) || "";
      labels.push((headers[c] ? headers[c] : "列" + (c + 1)) + (sample ? "（例: " + sample.slice(0, 14) + "）" : ""));
    }
    return { map, rows: data, labels, headerRow: h };
  }

  // ---- 判定用キーワード ----
  const CARD_PAYMENT = /(ミツイスミトモカ|三井住友カ|SMBC ?カ|ペイペイカ|PAYPAY ?カ|MUFG ?カ|ニコス|NICOS|JCB|VISA|クレジット|カ[-ー－]?ド(代金|ご?利用代金|ショッピング))/;
  const ATM = /(ATM|^カ[-ー－]?ド( |$)|カ[-ー－]?ド引出|現金|CD引出|セブン銀行|イ[-ー－]?ネット|ロ[-ー－]?ソン銀行)/;
  const FIXED_ALIASES = [
    { re: /(ANTHROPIC|CLAUDE)/, name: "Claude Pro" },
    { re: /SPOTIFY/, name: "Spotify" },
    { re: /DMM/, name: "DMM TV" },
    { re: /(日本通信|ニホンツウシン|ニツポンツウシン|B-MOBILE)/, name: "日本通信SIM" },
  ];
  const STORE_BILLING = /(GOOGLE ?PLAY|APPLE\.COM|ITUNES)/;
  const SUBSCRIPTION = /(MICROSOFT ?365|MICROSOFT\*|NETFLIX|YOUTUBE ?PREMIUM|AMAZON ?PRIME|プライム会費|U-NEXT|ABEMA|DAZN|HULU|DISNEY)/;
  const CATS = [
    ["食費", /(東武ストア|東急ストア|西友|まいばすけっと|カフェ|CAFE|クリエ|コ[-ー－]ヒ[-ー－]|セブン|ロ[-ー－]?ソン|ファミリ[-ー－]?マ[-ー－]?ト|ファミマ|ミニストップ|デイリ[-ー－]?ヤマザキ|NEWDAYS|ニュ[-ー－]?デイズ|松屋|マツヤ|すき家|スキヤ|吉野家|ヨシノヤ|なか卯|マクドナルド|MCDONALD|モスバ[-ー－]?ガ[-ー－]|ケンタッキ|ガスト|サイゼリヤ|スタ[-ー－]?バックス|STARBUCKS|ドト[-ー－]?ル|タリ[-ー－]?ズ|コメダ|西友|イオン|AEON|ライフ|マルエツ|ヤオコ[-ー－]|ベルク|ベイシア|業務ス[-ー－]?パ[-ー－]|ス[-ー－]?パ[-ー－]|UBER ?EATS|出前館|ウ[-ー－]?バ[-ー－]イ[-ー－]ツ|食堂|ラ[-ー－]?メン|弁当)/],
    ["交通", /(JR|旅客鉄道|SUICA|スイカ|PASMO|パスモ|メトロ|東武|西武|京急|京王|小田急|東急|都営|バス|タクシ[-ー－]|^GO$|GOタクシ)/],
    ["日用品", /(薬局|ヤツキヨク|ヤッキョク|マツモトキヨシ|マツキヨ|ウエルシア|ドラッグ|スギ薬局|ツルハ|サンドラッグ|ココカラ|ダイソ[-ー－]|DAISO|セリア|キャンドゥ|ニトリ|無印|MUJI|カインズ|ホ[-ー－]ムセンタ)/],
    ["趣味・娯楽", /(STEAM|VALVE|NINTENDO|ニンテンド|PLAYSTATION|SONY INTERACTIVE|アニメイト|ゲ[-ー－]マ[-ー－]ズ|メロンブックス|とらのあな|TSUTAYA|ツタヤ|カラオケ|映画|TOHO|シネマ|ヨドバシ|ビックカメラ|ドスパラ|ツクモ|パソコン工房|ソフマップ|APPLE\.COM|YOUTUBE)/],
    ["学業", /(書店|丸善|ジュンク堂|紀伊國屋|紀伊国屋|生協|COOP|大学|立教)/],
    ["衣服", /(ユニクロ|UNIQLO|^GU$|ジ[-ー－]ユ[-ー－]|ZARA|しまむら|H&M|ABCマ[-ー－]ト)/],
  ];
  function guessCategory(desc) {
    const d = norm(desc);
    for (const [c, re] of CATS) if (re.test(d)) return c;
    return "その他";
  }
  function entryKey(date, amount, desc) { return date + "|" + amount + "|" + norm(desc).replace(/\s/g, ""); }

  // ---- 取り込み候補 ----
  function buildCandidates(analysis, map, ctx) {
    ctx = ctx || {};
    const existing = new Set((ctx.existingKeys || []));
    const fixedNames = (ctx.fixedNames || []).map(norm).map((n) => n.split(" ")[0]).filter((n) => n.length >= 3);
    const seen = new Set();
    const out = [];
    analysis.rows.forEach((r, idx) => {
      const date = parseDate(r[map.date], ctx.today);
      if (!date) return;
      const main = map.desc > -1 ? (r[map.desc] || "") : "";
      const extra = map.desc2 > -1 ? (r[map.desc2] || "") : "";
      const desc = [extra, main].filter(Boolean).join(" ");
      let amount;
      if (map.kind === "bank") {
        const o = map.out > -1 ? parseAmount(r[map.out]) : null;
        if (!o) return; // 入金だけの行は取り込まない
        amount = Math.abs(o);
      } else {
        amount = map.amount > -1 ? parseAmount(r[map.amount]) : null;
        if (amount == null || amount === 0) return;
      }
      const d = norm(desc);
      let note = "", checked = true;
      const key = entryKey(date, amount, desc);
      let fixedHit = FIXED_ALIASES.find((a) => a.re.test(d)) || (fixedNames.find((n) => d.indexOf(n) > -1) ? { name: fixedNames.find((n) => d.indexOf(n) > -1) } : null);
      if (!fixedHit && STORE_BILLING.test(d)) {
        const same = (ctx.fixed || []).find((f) => Number(f.amount) === amount);
        fixedHit = { name: same ? same.name + "と同じ金額。ストア経由の支払い" : "ストア経由のサブスクや購入" };
      }
      if (existing.has(key) || seen.has(key)) { note = "取り込み済み"; checked = false; }
      else if (fixedHit) { note = "固定費と重なる可能性（" + fixedHit.name + "）"; checked = false; }
      else if (SUBSCRIPTION.test(d)) { note = "サブスクの可能性。毎月払うなら固定費に登録してください"; }
      else if (map.kind === "bank" && CARD_PAYMENT.test(d)) { note = "カードの引き落とし。カード明細と二重になります"; checked = false; }
      else if (map.kind === "bank" && ATM.test(d)) { note = "現金の引き出し。現金で使った分を手入力するなら外したままに"; checked = false; }
      else if (amount < 0) { note = "返金・取消"; }
      seen.add(key);
      out.push({ idx, date, desc, amount, category: amount < 0 ? "その他" : guessCategory(desc), checked, note, key });
    });
    return out;
  }

  const api = { decode, parseCSV, parseDate, parseAmount, analyze, buildCandidates, guessCategory, entryKey, norm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KakeiboCSV = api;
})(typeof self !== "undefined" ? self : this);
