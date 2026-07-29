// SPDX-License-Identifier: AGPL-3.0-or-later
// 汎用OPDS接続・カタログ・取り込みの状態（仕様書 §8, §9）。初期UIはMemlane専用
// だが、この store 自体は特定プロバイダー専用にしない（仕様書 §28）。
// 外部URL・secretはどのプロパティにも保持しない（サーバーは常に暗号化cursor /
// 接続summaryのみを返す — opds-entry.ts のパース関数を参照）。

import { apiGet, apiSend, ApiError } from "./api";
import { openLoginDialog } from "./authDialogs.svelte";
import type { EpubConvertOptions } from "./epub-options";
import type { JobEntry } from "./job-entry";
import {
  findConnectionByProvider,
  isImportableEntry,
  mapOpdsErrorCode,
  type OpdsCatalogPage,
  type OpdsConnectionSummary,
  type OpdsErrorMessageKey,
  OPDS_SELECTION_MAX,
  type OpdsPublicationEntry,
  parseCatalogPage,
  parseConnectionSummaries,
  parseConnectionSummary,
  runWithConcurrency,
  summarizeOpdsImportOutcomes,
  toggleOpdsSelection,
} from "./opds-entry";

// 初期リリースでフロントから作成・使用できるのは Memlane プリセットのみ
// （仕様書 §2.1, §13.3）。バックエンドの provider/authType 型自体は汎用のまま。
const MEMLANE_PROVIDER = "memlane";
const IMPORT_CONCURRENCY = 2; // 仕様書 §8.5「推奨同時実行数: 2」

interface ConnectionsResponse {
  connections?: unknown;
}

// Worker は POST /api/integrations/opds に対して常に { connection: {...} }
// (status 201, src/integrations/opds/routes.ts) を返す。トップレベル(素の
// summary)も受け付けているのはテスト容易性のため（このパース関数を単体で
// summary オブジェクト相手にテストしやすくする）の防御的な余地であり、
// Worker が実際にラップなしを返す想定ではない。
function parseConnectionResponse(body: unknown): OpdsConnectionSummary | null {
  const direct = parseConnectionSummary(body);
  if (direct) return direct;
  if (body && typeof body === "object") {
    return parseConnectionSummary((body as Record<string, unknown>).connection);
  }
  return null;
}

interface ImportResponse {
  jobId?: unknown;
}

function isSessionExpired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

// エラーから i18n キーを解決する。未対応の code は汎用の upstream エラー扱いに
// フォールバックする。
function opdsErrorKey(e: unknown): OpdsErrorMessageKey {
  if (e instanceof ApiError) {
    const key = mapOpdsErrorCode(e.code);
    if (key) return key;
  }
  return "memlane_upstream_error";
}

class OpdsStore {
  // --- Memlane 接続状態 -------------------------------------------------------
  connection = $state<OpdsConnectionSummary | null>(null);

  // --- 接続登録/置換ダイアログ -------------------------------------------------
  connectDialogOpen = $state(false);
  connectBusy = $state(false);
  connectErrorKey = $state<OpdsErrorMessageKey | null>(null);

  // --- カタログダイアログ -------------------------------------------------------
  catalogDialogOpen = $state(false);
  catalogLoading = $state(false);
  catalogErrorKey = $state<OpdsErrorMessageKey | null>(null);
  catalogPage = $state<OpdsCatalogPage | null>(null);
  // 戻る操作用の cursor 履歴（要素は「そのページに来る前にいた cursor」）。
  cursorHistory = $state<(string | null)[]>([]);
  currentCursor = $state<string | null>(null);
  searchQuery = $state("");

  selected = $state<Map<string, OpdsPublicationEntry>>(new Map());

  importBusy = $state(false);
  importSummary = $state<{ startedCount: number; failedCount: number } | null>(null);

  // 解除確認はネイティブ confirm() を使う（Library.svelte の delete 確認と
  // 同じ流儀）ため、この store は確認ダイアログ自体の開閉状態を持たない。
  disconnectBusy = $state(false);

  get selectedCount(): number {
    return this.selected.size;
  }

  isSelected(id: string): boolean {
    return this.selected.has(id);
  }

  get canGoBack(): boolean {
    return this.cursorHistory.length > 0;
  }

  // --- ボタン押下時（仕様書 §8.2） ---------------------------------------------
  async openMemlane(): Promise<void> {
    try {
      const body = await apiGet<ConnectionsResponse>("/api/integrations/opds");
      const connections = parseConnectionSummaries(body.connections);
      const memlane = findConnectionByProvider(connections, MEMLANE_PROVIDER);
      this.connection = memlane;
      if (memlane) {
        this.openCatalogDialog();
        await this.loadCatalog({ cursor: null, pushHistory: false });
      } else {
        this.openConnectDialog();
      }
    } catch (e) {
      if (isSessionExpired(e)) {
        this.handleSessionExpired();
        return;
      }
      // 接続一覧の取得自体に失敗した場合も、登録導線は必ず開けるようにする
      // （未接続として扱う — フェイルセーフ）。
      this.connection = null;
      this.openConnectDialog();
    }
  }

  openConnectDialog(): void {
    this.connectErrorKey = null;
    this.connectDialogOpen = true;
  }

  closeConnectDialog(): void {
    this.connectDialogOpen = false;
    this.connectErrorKey = null;
  }

  // 新規登録・既存接続の置換の両方をこのメソッドで扱う（仕様書 §8.6「更新」は
  // 同ダイアログを再利用する）。成功するまで既存接続は変えない。
  async submitConnect(catalogUrl: string): Promise<boolean> {
    const trimmed = catalogUrl.trim();
    if (!trimmed) return false;
    this.connectBusy = true;
    this.connectErrorKey = null;
    try {
      const body = await apiSend<unknown>("POST", "/api/integrations/opds", {
        name: "Memlane",
        provider: MEMLANE_PROVIDER,
        authType: "url_secret",
        catalogUrl: trimmed,
      });
      const connection = parseConnectionResponse(body);
      if (!connection) {
        this.connectErrorKey = "memlane_feed_invalid";
        return false;
      }
      // 置換時は古い cursor・カタログ state を破棄する（仕様書 §8.6）。
      this.connection = connection;
      this.resetCatalogState();
      this.connectDialogOpen = false;
      this.openCatalogDialog();
      await this.loadCatalog({ cursor: null, pushHistory: false });
      return true;
    } catch (e) {
      if (isSessionExpired(e)) {
        this.handleSessionExpired();
        return false;
      }
      this.connectErrorKey = opdsErrorKey(e);
      return false;
    } finally {
      this.connectBusy = false;
    }
  }

  // --- カタログダイアログ -------------------------------------------------------
  openCatalogDialog(): void {
    this.catalogDialogOpen = true;
  }

  closeCatalogDialog(): void {
    this.catalogDialogOpen = false;
  }

  private resetCatalogState(): void {
    this.catalogPage = null;
    this.catalogErrorKey = null;
    this.cursorHistory = [];
    this.currentCursor = null;
    this.searchQuery = "";
    this.selected = new Map();
    this.importSummary = null;
  }

  async loadCatalog(params: { cursor: string | null; pushHistory: boolean; search?: string }): Promise<void> {
    if (!this.connection) return;
    this.catalogLoading = true;
    this.catalogErrorKey = null;
    try {
      const qs = new URLSearchParams();
      if (params.cursor) qs.set("cursor", params.cursor);
      if (params.search) qs.set("search", params.search);
      const query = qs.toString();
      const path = `/api/integrations/opds/${encodeURIComponent(this.connection.id)}/catalog${query ? `?${query}` : ""}`;
      const body = await apiGet<unknown>(path);
      const page = parseCatalogPage(body);
      if (!page) {
        this.catalogErrorKey = "memlane_feed_invalid";
        return;
      }
      if (params.pushHistory) this.cursorHistory = [...this.cursorHistory, this.currentCursor];
      this.currentCursor = params.cursor;
      this.catalogPage = page;
      this.selected = new Map();
      this.importSummary = null;
    } catch (e) {
      if (isSessionExpired(e)) {
        this.handleSessionExpired();
        return;
      }
      this.catalogErrorKey = opdsErrorKey(e);
    } finally {
      this.catalogLoading = false;
    }
  }

  // 戻る操作先に来る前の cursor はあらかじめ pop してから読み込む。フェッチが
  // 失敗しても登録済みの履歴は戻さない（再度「戻る」を押せば良いだけのため、
  // 通常操作フローを複雑にしない簡略化）。
  async goBack(): Promise<void> {
    if (!this.canGoBack) return;
    const history = [...this.cursorHistory];
    const previous = history.pop() ?? null;
    this.cursorHistory = history;
    await this.loadCatalog({ cursor: previous, pushHistory: false });
  }

  async goToNavigationEntry(cursor: string): Promise<void> {
    await this.loadCatalog({ cursor, pushHistory: true });
  }

  async goNext(): Promise<void> {
    const cursor = this.catalogPage?.nextCursor;
    if (!cursor) return;
    await this.loadCatalog({ cursor, pushHistory: true });
  }

  async goPrevious(): Promise<void> {
    const cursor = this.catalogPage?.previousCursor;
    if (!cursor) return;
    await this.loadCatalog({ cursor, pushHistory: true });
  }

  // 空クエリでの検索実行はルートフィードへ戻す（仕様書に検索クリア時の挙動の
  // 明記はないため、単純さを優先した簡略化）。
  async search(query: string): Promise<void> {
    const trimmed = query.trim();
    this.searchQuery = trimmed;
    if (!trimmed) {
      await this.loadCatalog({ cursor: null, pushHistory: false });
      return;
    }
    const searchCursor = this.catalogPage?.searchCursor;
    if (!searchCursor) return;
    await this.loadCatalog({ cursor: searchCursor, pushHistory: true, search: trimmed });
  }

  // --- 選択（仕様書 §8.4「最大選択数: 5件」） -----------------------------------
  toggle(entry: OpdsPublicationEntry, checked: boolean): void {
    if (!isImportableEntry(entry)) return;
    this.selected = toggleOpdsSelection(this.selected, entry, checked, OPDS_SELECTION_MAX);
  }

  clearSelection(): void {
    this.selected = new Map();
  }

  // --- 取り込み実行（仕様書 §8.5。同時実行数2、1件失敗しても他を継続） -------------
  // registerCreatedJob は convert.svelte.ts のものをそのまま渡す想定
  // （仕様書 §9.2）。opds.svelte.ts 自体は convert.svelte.ts を import しない
  // — convert.svelte.ts は auth.svelte.ts に依存しており、auth.svelte.ts は
  // ログアウト時に opdsStore.reset() を呼ぶため opds.svelte.ts が
  // convert.svelte.ts を直接 import すると循環importになる（AozoraDialog.svelte
  // が submitUrl を直接呼ぶのと同様、呼び出し元コンポーネントに橋渡しを任せる）。
  async startImport(
    epubOptions: EpubConvertOptions,
    registerCreatedJob: (input: {
      jobId: string;
      sourceType: JobEntry["sourceType"];
      sourceLabel: string;
      title?: string;
    }) => void,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection || this.selected.size === 0) return;
    const entries = [...this.selected.values()];
    this.importBusy = true;
    this.importSummary = null;
    try {
      const outcomes = await runWithConcurrency(entries, IMPORT_CONCURRENCY, async (entry) => {
        try {
          const acquisitionCursor = entry.acquisitionCursor;
          if (!acquisitionCursor) return { id: entry.id, ok: false };
          const body = await apiSend<ImportResponse>(
            "POST",
            `/api/integrations/opds/${encodeURIComponent(connection.id)}/import`,
            { acquisitionCursor, title: entry.title, epubOptions },
          );
          if (typeof body.jobId !== "string") return { id: entry.id, ok: false };
          registerCreatedJob({
            jobId: body.jobId,
            sourceType: "epub",
            sourceLabel: `Memlane: ${entry.title}`,
            title: entry.title,
          });
          return { id: entry.id, ok: true };
        } catch (e) {
          if (isSessionExpired(e)) throw e; // 上位の catch でまとめて処理する
          return { id: entry.id, ok: false };
        }
      });
      this.importSummary = summarizeOpdsImportOutcomes(outcomes);
      this.clearSelection();
    } catch (e) {
      if (isSessionExpired(e)) {
        this.handleSessionExpired();
        return;
      }
    } finally {
      this.importBusy = false;
    }
  }

  // --- 接続解除（仕様書 §8.6「解除」）。呼び出し側で先に確認ダイアログ
  // （t("memlane_disconnect_confirm") を使った native confirm()）を通すこと。
  async disconnect(): Promise<void> {
    if (!this.connection) return;
    this.disconnectBusy = true;
    try {
      await apiSend("DELETE", `/api/integrations/opds/${encodeURIComponent(this.connection.id)}`);
    } catch (e) {
      if (isSessionExpired(e)) {
        this.handleSessionExpired();
        return;
      }
      // 削除リクエスト自体が失敗しても、UI 導線は未接続へ戻す（取り込み済み
      // library item・実行中Workflowはサーバー側で維持される — 仕様書
      // §8.6, §13.5）。次回ボタン押下時の一覧再取得で実際の状態と揃う。
    } finally {
      this.disconnectBusy = false;
    }
    this.connection = null;
    this.catalogDialogOpen = false;
    this.resetCatalogState();
  }

  // --- セッション切れ・ログアウト・アカウント切替（仕様書 §8.2, §28） -----------
  private handleSessionExpired(): void {
    this.reset();
    openLoginDialog();
  }

  reset(): void {
    this.connection = null;
    this.connectDialogOpen = false;
    this.connectBusy = false;
    this.connectErrorKey = null;
    this.catalogDialogOpen = false;
    this.catalogLoading = false;
    this.disconnectBusy = false;
    this.importBusy = false;
    this.resetCatalogState();
  }
}

export const opdsStore = new OpdsStore();
