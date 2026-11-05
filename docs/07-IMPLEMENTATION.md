# 07. 実装計画

## 1. 推奨ディレクトリ構成

ビルドツールなしの静的構成から始める（後で Vite 化してもよい）。

```text
figerless/
├── README.md
├── docs/                      # 本ドキュメント群
├── index.html
├── styles.css
├── src/
│   ├── main.js                # 起動・配線
│   ├── appState.js            # 状態機械
│   ├── camera.js              # getUserMedia
│   ├── handTracker.js         # MediaPipe ラッパ
│   ├── gripDetector.js        # 握りスコア
│   ├── penTipEstimator.js     # A/B/C/...
│   ├── smoother.js            # none/EMA/OneEuro
│   ├── coordinateMapper.js    # 正規化→canvas
│   ├── drawingEngine.js       # 線・ガイド・クリア
│   ├── calibration.js         # キャリブフロー
│   ├── metrics.js             # 誤差計算（実験用）
│   ├── ui.js                  # ボタン・セレクト接続
│   └── debugOverlay.js        # skeleton / 数値
└── vendor/ or CDN             # MediaPipe（方針は下記）
```

## 2. MediaPipe 導入方針

### 当面の推奨

- CDN から `@mediapipe/tasks-vision`（Hand Landmarker）を利用
- モデルファイル（`.task`）も公式配布を利用

### 注意

- `localhost` または HTTPS が必要
- 初回モデルダウンロードで遅延が出る → ローディング表示を入れる

## 3. 実装マイルストーン

ドキュメントの Phase 1〜3 を、実装タスクに分解する。

### M0 — 骨格（0.5日想定）

- [ ] `index.html` / 基本 CSS
- [ ] カメラ映像表示
- [ ] 空の Canvas
- [ ] ボタン類のプレースホルダ

### M1 — Phase1 認識（1日想定）

- [ ] getUserMedia 成功/失敗処理
- [ ] Hand Landmarker 初期化
- [ ] 21 landmark の取得
- [ ] skeleton オーバーレイ
- [ ] FPS / score 表示

**完了条件:** 手が映ると骨格が追従する。

### M2 — Phase2 推定（1日想定）

- [ ] `penTipEstimator` に A/B/C
- [ ] 仮想ペン先の点表示
- [ ] 方式セレクト UI
- [ ] L / offset のスライダ
- [ ] （任意）gripScore 表示

**完了条件:** 方式を切り替えると点の位置が変わる。

### M3 — 平滑化と写像（0.5〜1日）

- [ ] EMA
- [ ] One Euro
- [ ] CoordinateMapper（ミラー含む）
- [ ] 平滑化セレクト UI

**完了条件:** 静止時の点が明らかに安定するモードがある。

### M4 — Phase3 描画（1日想定）

- [ ] 描画開始/停止ボタン
- [ ] 軌跡の lineTo 描画
- [ ] 消去
- [ ] 手ロスト時のストローク切断
- [ ] ガイド線（水平/垂直/斜め）

**完了条件:** MVP 完成条件を満たす。

### M5 — キャリブ + 実験支援（1日想定）

- [ ] 簡易キャリブフロー
- [ ] localStorage 保存（任意）
- [ ] ガイドとの平均誤差表示
- [ ] 実験メモ用の表示（方式・パラメータ）

**完了条件:** 実験1〜4を回せる。

## 4. コーディング規約（最小）

- ES modules（`type="module"`）
- 推定・平滑化は純関数 / クラスで UI 非依存
- マジックナンバーは `config` オブジェクトへ集約
- 日本語 UI 文言、コード識別子は英語

## 5. 設定オブジェクト案

```js
export const defaultConfig = {
  camera: {
    width: 1280,
    height: 720,
    facingMode: 'user',
    mirror: true,
  },
  hand: {
    maxHands: 1,
    minDetectionConfidence: 0.6,
    minPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  },
  estimation: {
    mode: 'C',
    L: 0.12,
    offset: { x: 0, y: 0 },
  },
  smoothing: {
    mode: 'ema',
    emaAlpha: 0.3,
    oneEuro: { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 },
  },
  drawing: {
    color: '#111111',
    lineWidth: 3,
    cursorColor: '#0a7a3e',
  },
  guide: {
    mode: 'none', // none | horizontal | vertical | diagonal
    color: 'rgba(0,0,0,0.15)',
  },
};
```

## 6. テスト方針（手動中心）

自動化は最小限でよい。チェックリスト:

1. カメラ拒否時にエラーが出る
2. 手が入ると landmark が出る
3. A/B/C でカーソル位置が変わる
4. 描画 OFF では線が増えない
5. 描画 ON で線が追従する
6. 手が消えると線が途切れる
7. 消去で軌跡が消える
8. ガイド切替が即反映される
9. EMA で静止ブレが減る
10. キャリブ後に点が意図位置へ寄る（主観可）

## 7. 実装順序の原則

1. **動く画面** を先に作る（M0–M1）
2. **推定を純関数で足す**（M2）
3. **描いて比較できる状態**にする（M4）
4. 美醜・リファクタは実験の後

「完成度の高い UI」より「方式を切り替えて直線を比較できること」を優先する。
