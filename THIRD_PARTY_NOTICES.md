# サードパーティ・ソフトウェアに関する表示

本プロジェクト（html-to-xtc）は **Xteink 社とは無関係な非公式ツール**です。Xteink・X3 は各権利者の商標であり、本プロジェクトはそれらの権利者による承認・提携・保証を受けていません。

本リポジトリ自体のコードは [MIT License](LICENSE) です。リポジトリにはサードパーティのソースコードは含まれませんが、Docker イメージのビルド時・実行時に以下のソフトウェアを取得・使用します。**この Docker イメージを第三者に配布する場合**（レジストリでの公開、イメージファイルの受け渡し、変換サーバー一式の納品などを含む）は、以下の各ライセンスの条件（ライセンス本文・著作権表示・対応ソースの提供等）に従う必要があります。サーバー上で実行し変換結果のみをネットワーク越しに提供する現在の形態では、GPL-3.0 のいう「convey」には通常該当しません（ネットワーク条項を持つ AGPL-3.0 の PyMuPDF については下記の項を参照）。

## xtctool

- リポジトリ: https://github.com/chazeon/xtctool
- 使用コミット: `d7bff34ff835889e158ca8ff2253de06a3e825cf`（2026-07-17 検証）
- ライセンス: リポジトリの `LICENSE` ファイルは **GPL-3.0**。ただし同コミットの `pyproject.toml` は `license = {text = "MIT"}` と宣言しており、両者は矛盾している。本プロジェクトでは保守的に **GPL-3.0 として扱う**。
- 利用形態: `converter/Dockerfile` のビルド時に上記コミットを clone し venv へ `pip install`（extras: `[performance,markdown]`）。実行時はコンテナ内で CLI として subprocess 起動する（`converter/app.py`）。本リポジトリに xtctool のコードは含まれない。
- ビルド時に加えている変更: `pyproject.toml` の `[tool.hatch.build.targets.wheel.force-include]` セクション（2 行）を `sed` で削除している。新しめの hatchling が `packages = ["xtctool"]` と重複する include を拒否するための、パッケージング設定のみの変更であり、**ソースコード本体は改変していない**。

## PyMuPDF

- https://pymupdf.readthedocs.io/ （xtctool の必須依存としてインストールされる）
- ライセンス: **AGPL-3.0 と Artifex 商用ライセンスのデュアルライセンス**。
- 利用形態: xtctool が内部で使用するほか、`converter/app.py` が PDF のメタデータ読み取りのために直接 import する。**改変せず**、そのまま使用している。
- 留意点: AGPL-3.0 第 13 条の文言は「改変した場合（if you modify the Program）」を対象とするが、FSF は一般に、ライブラリの import やリンクによって結合されたプログラムは「combined work」になり得るという立場を示している。本サービスは `converter/app.py` が PyMuPDF を直接 import しており、xtctool も PyMuPDF を直接依存に持つ。さらに権利者の Artifex は公式ライセンスページで、AGPL 版をサーバーベースのアプリケーションやサービスに組み込む場合はアプリケーション全体のソースを AGPL で開示する必要があるとの立場を明示している。**PyMuPDF および MuPDF の AGPL 適用範囲については、サーバーサービスへの組み込みを含め解釈上の論点がある。公開・運用にあたっては、AGPL-3.0 の条件および権利者（Artifex）のライセンスポリシーを確認すること。**なお、本リポジトリのソースが GitHub で公開されていても、リポジトリ全体を MIT として表示している現状は「公開しているから自動的に AGPL 準拠」という状態ではない。イメージを配布する場合は AGPL-3.0 の条件（ライセンス本文と対応ソースの提供等）に従う必要がある。

## その他の依存関係

- xtctool の推移的依存（click、Pillow、numpy、requests、tqdm、numba、typst、jinja2 など）は、それぞれのライセンスに従ってビルド時にインストールされる。
- Worker 側の npm 依存は [package.json](package.json) を参照。

本ファイルは網羅的なライセンス調査の結果ではない。イメージや成果物を配布する際は、その時点の依存関係で改めてライセンスを確認すること。
