# シブガレット（cigarette-app）

カメラに映したペンを認識し、ペンの位置・角度・長さに合わせて**タバコの CG を重ねて表示する**、ブラウザで動く AR アプリです。
口元に近づけると火の先から煙が上がり、口をすぼめると口から煙を吐く演出になります。指パッチンやライター（に見立てた小物）で「着火」もできます。

> **注意**：機能はすべて合成画像・写真・仮想カメラを使った自動テストで確認したものです。**実際のカメラ・実際のペン・スマートフォンでの動作は、まだ確認していません**（「現在の実装状況」参照）。

## 主な機能

| 機能 | 内容 |
| --- | --- |
| ペンの認識 | OpenCV.js で、色（ピンク・青・緑・赤、画面をタップして登録した色）と形（細長さ・直線性・幅の均一性など）からペンを認識。指でペンが分断されても 1 本として扱う |
| タバコ CG | ペンの位置・角度・長さ・太さに合わせてタバコの CG を重ねる。CG の種類は タバコ / 葉巻 / パイプ / 自動 から選べる |
| 口元の検出 | MediaPipe Face Landmarker で唇の位置と口の形を取得し、口元に近い端を吸い口にする（向きの自動補正） |
| 煙 | 吸う（タバコの先から煙）・吐く（口から煙）を状態機械で判定し、パーティクルで描く。量・速度・広がり・濃さを調整できる |
| 着火 | MediaPipe Hand Landmarker による指パッチン、または単色の長方形の小物をライターとして認識し、炎を出す。炎をタバコの先に当てると着火し、着火中だけ煙が出る |
| 複数人 | 1 人 / 2 人 / 3 人モード。顔とペンに追跡 ID を付け、ペンを持ち主に割り当てて、人物ごとに着火・煙を管理する |

## 使用技術

- Vite 8 + React 19 + TypeScript 6
- OpenCV.js（`@techstark/opencv-js`）：ペン・ライターの認識
- MediaPipe Tasks Vision（`@mediapipe/tasks-vision`）：顔（Face Landmarker）と手（Hand Landmarker）の認識。モデルは `public/models/` に同梱
- Canvas 2D：タバコ CG・炎・煙の描画
- Capacitor 8：iOS アプリ化（中身は同じ Web 版を WKWebView で動かす）
- oxlint（Lint）、Node.js 標準の `node:test`（単体テスト）

画像の処理と推論は**すべて端末内**で行い、カメラの映像を外部に送信しません。

- MediaPipe（1.1.1）が自動で行う利用統計の送信（`odml.pa.googleapis.com`）も止めています（`src/lib/telemetryGuard.ts`）。
- 利用統計には映像は含まれません。

## ディレクトリ構成

```
cigarette-app/
├── capacitor.config.ts      iOS アプリ（Capacitor）の設定
├── docs/TECH_SPEC.md        技術仕様書（設計・アルゴリズム・検証状況・既知の制約・変更履歴）
├── ios/                     iOS アプリの Xcode プロジェクト（ios/App/App.xcodeproj）
├── public/models/           MediaPipe のモデル（face_landmarker.task / hand_landmarker.task）
├── src/
│   ├── components/          画面（PenTracker.tsx：カメラ・描画ループ・設定 UI）
│   ├── hooks/               OpenCV.js の読み込み
│   └── lib/                 認識・追跡・描画の処理（React に依存しない）
│       ├── penDetector.ts / penGeometry.ts / penShape.ts / penColors.ts   ペンの認識（色・形・結合）
│       ├── penTracking.ts / multiPenTracker.ts                          ペンの追跡
│       ├── mouthTracker.ts / faceTracks.ts / handTracker.ts             顔・手（MediaPipe）
│       ├── penAssignment.ts / personController.ts                       ペンと人物の対応付け・人物ごとの状態
│       ├── cigaretteRenderer.ts / cigaretteOrientation.ts               タバコ CG と向き
│       ├── smokeEffect.ts / smokeStateMachine.ts                        煙
│       └── snapDetector.ts / ignition.ts / flameEffect.ts / lighter*.ts / fireController.ts   指パッチン・着火・炎・ライター
└── tests/                   単体テスト（node:test）
```

## 必要な開発環境

- **Node.js 24**（`.nvmrc` に記載）と npm
  - nvm を使う場合：`nvm use`
  - Homebrew の場合：`brew install node@24` のあと、そのシェルで `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`（グローバルの `brew link` は変えなくてよい）
- カメラの付いた PC と、Chrome などのブラウザ
  - ブラウザがカメラを使えるのは `localhost` か HTTPS のページだけです。

## インストール手順

```sh
git clone https://github.com/t-owada-chibatech/cigarette-app.git
cd cigarette-app
npm install
```

## ローカルでの起動

```sh
npm run dev
```

表示された `http://localhost:5173/` をブラウザで開き、「カメラ起動」を押してカメラの使用を許可します。

- 初回は OpenCV.js（約 13MB）と MediaPipe の読み込みに数秒かかります。
- **スマートフォンのブラウザ**：
  - 同じネットワークの PC から開くと `http://` になるため、カメラを使えません。
  - HTTPS で配信する設定は、まだ用意していません。iPhone では、下の iOS アプリを使います。

## iOS アプリ（Capacitor）

必要なもの：macOS、Xcode（27.0 で確認）、iPhone（iOS 16.4 以上）、Apple アカウント（無料のアカウントでも自分の iPhone へのインストールは可能）。

```sh
npm install
npm run ios:sync    # Web 版をビルドして ios/App/App/public にコピー（npm run build && npx cap sync ios）
npm run ios:open    # Xcode でプロジェクトを開く（npx cap open ios）
```

Xcode での手順：

1. Xcode で **App** ターゲットの **Signing & Capabilities** を開き、**Team** に自分の Apple アカウント（Personal Team など）を選ぶ。
   - **Bundle Identifier**（既定は `io.github.towadachibatech.shibugarette`）が他と重複していると言われたら、自分用の値に変える。
2. iPhone を USB で接続し、iPhone 側で **設定 → プライバシーとセキュリティ → デベロッパモード** をオンにする（初回のみ。再起動が必要）。
3. Xcode の上部の実行先に自分の iPhone を選び、▶（Run）を押す。
4. 初回は iPhone 側で **設定 → 一般 → VPN とデバイス管理** から、自分の開発元を信頼する。
5. アプリを開き、「カメラ起動」を押して、カメラの使用を許可する。

- Web のコードを変えたら、`npm run ios:sync` をやり直してから Xcode で Run します。
- OpenCV.js・MediaPipe の WASM とモデルはアプリに同梱しているので、オフラインでも動く想定です（未確認）。

## ビルド・テスト

```sh
npm run build     # 型チェック（tsc）と本番ビルド（dist/ に出力）
npm run preview   # ビルド結果をローカルで確認
npm run lint      # oxlint
npm test          # 単体テスト（152 件）
```

## 現在の実装状況

| STEP | 内容 | 状況 |
| --- | --- | --- |
| 1 / 1.1 | ピンク色のペン認識、指で分断されたペンの結合、追跡 | 実装済み・自動テスト済み・実機未検証 |
| 2 | タバコ CG の重畳 | 実装済み・自動テスト済み・実機未検証 |
| 3 / 3.1 / 3.2 | 口元の検出、向きの自動補正、吸う・吐くに連動した煙 | 実装済み・自動テスト済み・実機未検証 |
| 4 | 指パッチン・ライターによる着火、炎 | 実装済み・自動テスト済み・実機未検証（**指パッチンは実際の手で未確認**） |
| 5 | 複数人の同時認識 | 実装済み・自動テスト済み・実機未検証（実際の 2〜3 人では未確認） |
| 6 | 複数色のペン認識、形状による誤認識の防止、色の登録、葉巻・パイプの CG | 実装済み・自動テスト済み・実機未検証（黒・白・グレーのペンは未対応（実験的）） |
| 8 | iOS アプリ化（Capacitor） | 実装済み・Xcode でのビルドとシミュレーターでの起動を確認・**iPhone 実機では未確認**（カメラ・認識・性能も未確認） |
| 7 | YOLOE（機械学習モデル）によるペン認識 | 試験したが**不採用**（推論の遅れで CG がずれるため）。アプリには含まない |
| 今後 | ペンの先端・後端の判定、指の前後関係、元のペンを消す処理、スマートフォンでの最適化 | 未着手 |

「自動テスト済み」は、単体テストと、Chrome の仮想カメラに合成動画・写真を入力したブラウザのテストで確認したという意味です。詳細は技術仕様書の第 11 章を参照してください。

## 既知の制約

- **元のペンは消えません**。CG はペンの上に重ねて描くだけなので、CG からはみ出した部分のペンは見えます。
- ペンの先端と後端は区別しません。吸い口の向きは、口元に近い端で決めます。
- 色と形でペンを認識するので、同じ色で細長い物（ストライプの服・ケーブルなど）をペンと誤認識することがあります。
- 吐く動作は口の形（口すぼめ）で判定する擬似的なもので、実際の息は検出しません。
- 処理はすべて 2D で、奥行きは考慮しません。
- スマートフォン（iOS アプリを含む）での動作・性能は未確認です。iOS アプリは、バックグラウンドから戻ると「カメラ起動」を押し直す必要がある見込みです。
- その他の制約は、技術仕様書の第 12 章にまとめています。

## 技術仕様書

設計・アルゴリズム・パラメータ・検証状況・既知の制約・変更履歴は [`docs/TECH_SPEC.md`](docs/TECH_SPEC.md) にまとめています。機能を変更したときは、仕様書も合わせて更新してください。

## 共同開発の進め方

1. `main` から作業用のブランチを作る：`git switch -c feature/作業内容`（例：`feature/smoke-color`、`fix/lighter-detection`）
2. 変更したら `npm run build`・`npm run lint`・`npm test` がすべて通ることを確認してコミットする。
3. `git push -u origin feature/作業内容` で push し、GitHub で `main` への Pull Request を作る。
4. 他のメンバーがレビューしてから `main` にマージする。

その他の注意：

- `main` への直接の push や force push はしない。
- `.env` などの認証情報・個人情報・大きなデータは、コミットしない（`.gitignore` で除外している）。

## 同梱しているファイルのライセンス

- `public/models/face_landmarker.task` と `public/models/hand_landmarker.task` は、Google が配布している MediaPipe のモデルです（Apache License 2.0）。
- このリポジトリのソースコードのライセンスは、まだ決めていません。
