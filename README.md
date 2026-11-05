# HandPen AI

ペンを持たずに、ペンを握る手の形と動きから**仮想ペン先**を推定し、画面に線を描くシステムの試作プロジェクトです。

最終目標は iPad 上でペンなしイラスト描画を実現することですが、本リポジトリの当面の範囲は **Web カメラ PoC（Phase 1〜3）** です。

## いま検証する仮説

> ペンを握るときと同じ手の形を作り、手首・手全体を動かすことで、カメラが仮想的なペン先の位置を推定し、画面上に線を描けるのではないか。

最初の成功条件は「自由なイラスト」ではなく、**意図した位置に直線を一本引けること**です。

## 開発ドキュメント

構成・仕様・実験計画は `docs/` に集約しています。実装前に読む順序:

| 順 | ドキュメント | 内容 |
|---|---|---|
| 1 | [docs/00-INDEX.md](docs/00-INDEX.md) | ドキュメント全体の案内 |
| 2 | [docs/01-PRODUCT.md](docs/01-PRODUCT.md) | ビジョン・MVP・ロードマップ |
| 3 | [docs/02-ARCHITECTURE.md](docs/02-ARCHITECTURE.md) | システム構成・モジュール分割 |
| 4 | [docs/03-SPEC-WEB.md](docs/03-SPEC-WEB.md) | Web版の実装仕様 |
| 5 | [docs/04-VIRTUAL-PEN.md](docs/04-VIRTUAL-PEN.md) | 仮想ペン先推定（コア） |
| 6 | [docs/05-CALIBRATION.md](docs/05-CALIBRATION.md) | キャリブレーション仕様 |
| 7 | [docs/06-EXPERIMENTS.md](docs/06-EXPERIMENTS.md) | 実験計画・評価指標 |
| 8 | [docs/07-IMPLEMENTATION.md](docs/07-IMPLEMENTATION.md) | 実装計画・ディレクトリ構成 |
| 9 | [docs/08-DESIGN-NOTES.md](docs/08-DESIGN-NOTES.md) | 補強案・未決事項・リスク |

## 現在のフェーズ

```
Phase 1  Webカメラによる手の認識
Phase 2  仮想ペン先の座標推定
Phase 3  直線描画
─── 今回の完成ライン（Web MVP）───
Phase 4〜  個人差補正・曲線・iPad化 …
```

## 技術スタック（Web PoC）

- HTML / CSS / JavaScript
- MediaPipe Hand Landmarker（21 landmark）
- Canvas API
- `navigator.mediaDevices.getUserMedia()`

## デモの起動

Chrome / Edge でローカルサーバー経由で開いてください（カメラは `localhost` または HTTPS が必要です）。

```bash
npm start
```

ブラウザで http://localhost:5173 を開き、**カメラ開始** → 手を映す → **描画開始** の順で操作します。

### 操作の流れ

1. ペンを握る形で手をカメラに映す（骨格＋黄色い仮想ペン先が表示される）
2. 必要なら **キャリブ（十字合わせ）** で点を中央に合わせる
3. **描画開始** を押し、ガイド線に沿って手を動かす
4. 推定方式 A/B/C/D や平滑化を切り替えて比較する

## 実装ファイル

| パス | 役割 |
|---|---|
| `index.html` / `styles.css` | UI |
| `src/main.js` | 起動・ループ・UI接続 |
| `src/handTracker.js` | MediaPipe Hand Landmarker |
| `src/penTipEstimator.js` | 仮想ペン先 A/B/C/D |
| `src/smoother.js` | EMA / One Euro |
| `src/drawingEngine.js` | 線・ガイド・カーソル |
