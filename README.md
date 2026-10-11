# 轉乘規劃

台北捷運＋公車轉乘規劃網頁，全部在瀏覽器執行，不需要伺服器。

- 公車：臺北市公車開放資料（站序、班距、即時到站）
- 捷運：`mrt-data.js`（站序與座標，座標取自 OpenStreetMap）
- 地址查詢：ArcGIS World Geocoder，失敗時改用 OpenStreetMap Nominatim

行車時間為依距離估算的近似值；第一段公車使用即時到站資料。

本機測試：

```bash
python3 -m http.server 8772
```
