// 使用統計（GoatCounter，免費、不用 cookie）：記錄造訪次數，以及每次搜尋的起點 → 終點。
// GC_CODE 留空時完全不啟動，不會送出任何資料。
const GC_CODE = 'maverickwei';

const Stats = (() => {
  if (GC_CODE) {
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://gc.zgo.at/count.js';
    s.dataset.goatcounter = `https://${GC_CODE}.goatcounter.com/count`;
    document.head.appendChild(s);
  }

  // 只記錄畫面上顯示的文字；「目前位置」「家」不會換成實際座標或地址
  function label(v) {
    v = (v || '').trim();
    if (/^@?\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(v)) return '座標';
    return v.replace(/^📍\s*/, '').slice(0, 60) || '（空白）';
  }

  function search(from, to) {
    if (!GC_CODE) return;
    const title = `${label(from)} → ${label(to)}`;
    // 另送一筆含搜尋時間（手機時間，到分鐘）的記錄，統計頁就看得到每一次是幾點幾分
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const stamp = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const send = () => {
      window.goatcounter.count({ path: 'search: ' + title, title, event: true });
      window.goatcounter.count({ path: `log: ${stamp} ${title}`, title: `${stamp} ${title}`, event: true });
    };
    // count.js 是非同步載入，還沒好就稍後再送
    if (window.goatcounter && window.goatcounter.count) send();
    else setTimeout(() => window.goatcounter && window.goatcounter.count && send(), 2000);
  }

  return { search };
})();
