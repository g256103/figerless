# 02. アーキテクチャ

## 1. データフロー（全体）

```
Webカメラ
  │
  ▼
CameraService          映像取得・解像度・ミラー設定
  │
  ▼
HandTracker            MediaPipe Hand Landmarker
  │                    → 21 landmarks / handedness / score
  ▼
GripDetector           ペン握り形かどうかを簡易判定（任意）
  │
  ▼
PenTipEstimator        方式 A/B/C/... で仮想ペン先を計算
  │
  ▼
Smoother               なし / EMA / One Euro
  │
  ▼
CoordinateMapper       カメラ正規化座標 → Canvas 座標
  │                    （キャリブレーション結果を反映）
  ▼
DrawingEngine          描画ON時に線分を追加・消去・ガイド表示
  │
  ▼
UI / DebugOverlay      状態・座標・方式・FPS を表示
```

## 2. モジュール責務

| モジュール | 責務 | 依存してよいもの | 依存してはいけないもの |
|---|---|---|---|
| `CameraService` | getUserMedia、video 要素制御 | DOM | MediaPipe / 描画 |
| `HandTracker` | landmark 検出 | Camera / MediaPipe | 推定式・Canvas |
| `GripDetector` | 握り形スコア | landmarks | 描画状態 |
| `PenTipEstimator` | \(P_{\mathrm{pen}}\) 計算 | landmarks + パラメータ | Canvas |
| `Smoother` | 時系列平滑化 | 2D点 | MediaPipe |
| `CoordinateMapper` | 空間変換 | キャリブ結果 | 推定式の詳細 |
| `DrawingEngine` | 軌跡・ガイド・クリア | Canvas 座標点 | MediaPipe |
| `Calibration` | 長さ L・オフセット・写像取得 | landmarks | DrawingEngine |
| `AppController` | 状態機械・UIイベント接続 | 全モジュール | — |

この分割により、「線がガタつく」原因が認識・推定・補正・写像のどれかを切り分けやすくする。

## 3. 状態機械（App）

```
Idle
  │ [カメラ開始]
  ▼
CameraReady
  │ [キャリブ開始] ──► Calibrating ──► CameraReady
  │ [描画開始]
  ▼
Drawing
  │ [描画停止]
  ▼
CameraReady
```

補助状態:

- `NoHand` … 手が検出されていない（描画中は線を伸ばさない）
- `LowConfidence` … スコア低下（点を落とす / 線を切る方針は実験で決定）

## 4. 座標系

3つの空間を明示的に分ける。

| 空間 | 範囲 | 用途 |
|---|---|---|
| Camera Normalized | MediaPipe 出力（概ね 0–1） | 推定計算の入力 |
| Camera Pixel | video の実ピクセル | デバッグ描画（骨格オーバーレイ） |
| Canvas Pixel | 描画キャンバス | 最終の線描画・誤差評価 |

推定は原則 **正規化座標** で行い、最後に Canvas へ写像する。  
評価（ガイド線との誤差）は必ず **同じ Canvas 座標系** で行う。

### ミラー（左右反転）方針

Web カメラはセルフィーと同様に左右反転表示することが多い。

- **表示用 video / skeleton**: ユーザー直感のためミラー表示を推奨
- **計算用 landmark**: ミラー後の座標系で一貫して扱う（表示と計算を食い違わせない）

実装時は「ミラーは CameraService か Mapper の一箇所だけ」で吸収する。

## 5. 実行ループ

```
requestAnimationFrame / MediaPipe の結果コールバック
  1. landmarks 取得
  2. (任意) grip score 計算
  3. P_pen_raw = estimate(mode, landmarks, params)
  4. P_pen_smooth = smoother.update(P_pen_raw)
  5. P_canvas = mapper.toCanvas(P_pen_smooth)
  6. if drawingEnabled && handPresent:
         drawingEngine.lineTo(P_canvas)
  7. debugOverlay.render(...)
```

目標: 可能な範囲で **1フレーム内に完結**。重い処理を増やさない。

## 6. 設定パラメータ（ランタイム変更可能）

実験比較のため、UI または設定オブジェクトで切り替え可能にする。

```text
estimationMode: 'A' | 'B' | 'C' | ...
smoothingMode: 'none' | 'ema' | 'oneEuro'
emaAlpha: 0.1〜1.0
oneEuro: { minCutoff, beta, dCutoff }
penLengthL: 正規化空間での仮想ペン長
offset: { x, y }
guideMode: 'none' | 'horizontal' | 'vertical' | 'diagonal'
mirrorVideo: boolean
```

## 7. Web 構成案（単一ページ）

当面はビルドツールなしでも動く構成を推奨する。

```
index.html
styles.css
src/
  main.js
  camera.js
  handTracker.js
  gripDetector.js
  penTipEstimator.js
  smoother.js
  coordinateMapper.js
  drawingEngine.js
  calibration.js
  ui.js
  debug.js
```

詳細は [07-IMPLEMENTATION.md](07-IMPLEMENTATION.md)。

## 8. iPad 将来互換のための設計制約

Web で成功しても iPad 前面カメラ＋掌接触では条件が変わる。  
そのため Web PoC でも次を守る。

1. **推定ロジックをカメラ依存から切り離す**（landmarks → tip の純関数にする）
2. **欠損 landmark を想定したインターフェースを残す**（将来の隠れ指対策）
3. **接触情報はまだ使わないが、入力スロットだけ将来追加可能にする**
4. Web 特有の最適化（全身が見える前提のヒューリスティック）を推定コアに埋め込まない

## 9. 非機能要件

| 項目 | 目標 |
|---|---|
| 動作環境 | 最新 Chrome / Edge（デスクトップ） |
| 入力 | 内蔵 or USB Web カメラ |
| レイテンシ感 | 手の動きに対して体感で追従（目標 100ms 以内） |
| 依存 | CDN 経由の MediaPipe で開始可 |
| データ保存 | 当面ローカルのみ（localStorage でキャリブ結果は任意） |
