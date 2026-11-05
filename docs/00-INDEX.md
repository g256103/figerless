# HandPen AI — 開発ドキュメント索引

このフォルダは、HandPen AI の **Web カメラ PoC（Phase 1〜3）** を実装・実験するための設計資料です。

## 読み方

1. **方針を掴む** → [01-PRODUCT.md](01-PRODUCT.md)
2. **全体構造を掴む** → [02-ARCHITECTURE.md](02-ARCHITECTURE.md)
3. **画面と処理の詳細** → [03-SPEC-WEB.md](03-SPEC-WEB.md)
4. **発明の核（推定モデル）** → [04-VIRTUAL-PEN.md](04-VIRTUAL-PEN.md)
5. **個人差への初期対応** → [05-CALIBRATION.md](05-CALIBRATION.md)
6. **何を測って成功と判断するか** → [06-EXPERIMENTS.md](06-EXPERIMENTS.md)
7. **どう実装するか** → [07-IMPLEMENTATION.md](07-IMPLEMENTATION.md)
8. **まだ決めていない案・補強案** → [08-DESIGN-NOTES.md](08-DESIGN-NOTES.md)
9. **画面手置き + 想定ペン先指定** → [09-ONSCREEN-TIP-CALIB.md](09-ONSCREEN-TIP-CALIB.md)
10. **Palm Rejection の限界** → [10-PALM-REJECTION.md](10-PALM-REJECTION.md)

## 設計の三層（常に分離する）

このプロジェクトでは、次の3つを混ぜないことが最重要です。

| 層 | 役割 | 今使う手段 |
|---|---|---|
| **認識 (Perception)** | カメラから手の位置・姿勢を取る | MediaPipe Hand Landmarker |
| **推定 (Estimation)** | 手の姿勢から仮想ペン先を計算する | 幾何モデル A/B/C（拡張可） |
| **補正 (Correction)** | ブレ・個人差・座標変換を調整する | EMA / One Euro / キャリブレーション |

認識技術自体は既存です。**差別化と検証の中心は「推定」**に置きます。

## ドキュメントの更新ルール

- 仕様を変えたら、まず該当 docs を更新してからコードを変える
- 実験結果は [06-EXPERIMENTS.md](06-EXPERIMENTS.md) の結果欄、または後続で `docs/results/` に追記する
- 大きな方針変更は [08-DESIGN-NOTES.md](08-DESIGN-NOTES.md) の意思決定ログに残す

## 用語集（短縮）

| 用語 | 意味 |
|---|---|
| 仮想ペン先 / \(P_{\mathrm{pen}}\) | 実際のペンを持っていないときに推定する描画座標 |
| 握り位置 / \(G\) | 親指・人差し指などから求める仮想的なグリップ点 |
| Landmark | MediaPipe が返す手の21特徴点 |
| EMA | 指数移動平均による平滑化 |
| One Euro Filter | 速度適応型の平滑フィルタ |
| Guide line | 実験用の水平/垂直/斜めガイド線 |
| Grip pose | ペンを握る手の形ができている状態 |
