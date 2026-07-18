# サードパーティ・ソフトウェアに関する表示

本プロジェクト（html-to-xtc）は **Xteink 社とは無関係な非公式ツール**です。Xteink・X3 は各権利者の商標であり、本プロジェクトはそれらの権利者による承認・提携・保証を受けていません。

本リポジトリ自体のコードは [GNU AGPL-3.0-or-later](LICENSE) です。リポジトリにはサードパーティのソースコードは含まれませんが、Docker イメージのビルド時・実行時に以下のソフトウェアを取得・使用します。**この Docker イメージを第三者に配布する場合**（レジストリでの公開、イメージファイルの受け渡し、変換サーバー一式の納品などを含む）は、以下の各ライセンスの条件（ライセンス本文・著作権表示・対応ソースの提供等）に従う必要があります。サーバー上で実行し変換結果のみをネットワーク越しに提供する現在の形態では、GPL-3.0 のいう「convey」には通常該当しません（ネットワーク条項を持つ AGPL-3.0 の PyMuPDF については下記の項を参照）。

## xtctool

- リポジトリ: https://github.com/chazeon/xtctool
- 使用コミット: `d7bff34ff835889e158ca8ff2253de06a3e825cf`（2026-07-17 検証）
- ライセンス: リポジトリの `LICENSE` ファイルは **GPL-3.0**。ただし同コミットの `pyproject.toml` は `license = {text = "MIT"}` と宣言しており、両者は矛盾している。本プロジェクトでは保守的に **GPL-3.0 として扱う**。
- 利用形態: `converter/Dockerfile` のビルド時に上記コミットを clone し venv へ `pip install --no-deps`（extras: `[performance,markdown]`）。依存パッケージは事前に [converter/requirements.lock](converter/requirements.lock) からバージョン・ハッシュ固定でインストールされる。実行時はコンテナ内で CLI として subprocess 起動する（`converter/app.py`）。本リポジトリに xtctool のコードは含まれない。
- ビルド時に加えている変更: `pyproject.toml` の `[tool.hatch.build.targets.wheel.force-include]` セクション（2 行）を `sed` で削除している。新しめの hatchling が `packages = ["xtctool"]` と重複する include を拒否するための、パッケージング設定のみの変更であり、**ソースコード本体は改変していない**。

## PyMuPDF

- https://pymupdf.readthedocs.io/ （xtctool の必須依存としてインストールされる）
- ライセンス: **AGPL-3.0 と Artifex 商用ライセンスのデュアルライセンス**。
- 利用形態: xtctool が内部で使用するほか、`converter/app.py` が PDF のメタデータ読み取りのために直接 import する。**改変せず**、そのまま使用している。
- 対応方針: FSF は一般に、ライブラリの import やリンクによって結合されたプログラムは「combined work」になり得るという立場を示しており、本サービスは `converter/app.py` が PyMuPDF を直接 import し、xtctool も PyMuPDF を直接依存に持つ。さらに権利者の Artifex は公式ライセンスページで、AGPL 版をサーバーベースのアプリケーションやサービスに組み込む場合はアプリケーション全体のソースを AGPL で開示する必要があるとの立場を明示している。本プロジェクトはこの保守的な解釈に沿い、**本リポジトリ全体を AGPL-3.0-or-later で公開している**。サービスの利用者は WebUI フッターのリンク（https://github.com/aGFydWtp/html2xtc）から、稼働版に対応するソースコードを取得できる（稼働版との対応関係はデプロイごとに記録する Git タグ / commit で示す。[README のライセンス節](README.md#ライセンス)参照）。イメージを第三者に配布する場合は、別途 AGPL-3.0 の条件（ライセンス本文と対応ソースの提供等）に従う必要がある。

## その他の依存関係

- xtctool の推移的依存（click、Pillow、numpy、requests、tqdm、numba、typst、jinja2 など）は、それぞれのライセンスに従ってビルド時にインストールされる。全 pip 依存は [converter/requirements.lock](converter/requirements.lock) でバージョン・ハッシュとも完全固定しており、同じ Git リビジョンから再ビルドすれば稼働版と同一バージョンの依存構成が再現される（AGPL の対応ソースの再現性確保）。
- Worker 側の npm 依存は [package.json](package.json) を参照。

本ファイルは網羅的なライセンス調査の結果ではない。イメージや成果物を配布する際は、その時点の依存関係で改めてライセンスを確認すること。
