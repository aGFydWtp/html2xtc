// SPDX-License-Identifier: AGPL-3.0-or-later
// 青空文庫ダイアログの検索・選択状態。検索は 350ms デバウンスで自前 API
// GET /api/books?q=&page=&limit= を叩き、検索シーケンス番号で stale レスポンスを破棄する。
// 開くたびに show() で検索・選択状態を全てリセットする。
// サーバーは総件数を返さない（LIKE 全表スキャンで COUNT を撃たない設計）ため、
// 「N件中M件」のような表示はできず hasNext（次ページの有無）のみで追加読み込みを制御する。

// GET /api/books のレスポンス項目（camelCase）。htmlUrl は常に非空保証。
export interface AozoraBook {
  workId: string;
  title: string;
  subtitle: string | null;
  author: string;
  htmlUrl: string;
  cardUrl: string;
  copyrighted: boolean;
}

// 結果リスト領域の表示状態。results 以外はステータス文言のみを表示する。
export type AozoraListState = "start" | "searching" | "empty" | "fail" | "results";

// 追加読み込み（次ページ取得）の状態。listState とは独立に持ち、末尾スピナーと
// 全体の「検索中」表示を出し分ける。
export type AozoraMoreState = "idle" | "loading" | "fail";

export const AOZORA_MAX = 5; // ダイアログで選択できる作品数の上限（検索結果件数の上限ではない）
export const AOZORA_FETCH_LIMIT = 100; // 1リクエストで取得する件数。サーバー上限（1..100）に合わせる
const DEBOUNCE_MS = 350;

interface BooksResponse {
  books?: unknown;
  hasNext?: unknown;
}

class AozoraDialog {
  open = $state(false);
  query = $state("");
  results = $state<AozoraBook[]>([]);
  listState = $state<AozoraListState>("start");
  hasNext = $state(false); // 次ページの有無。サーバーは総件数を返さないためこれのみで判定する。
  moreState = $state<AozoraMoreState>("idle");
  // workId -> book。選択順の保持と重複排除を Map で行う。ミューテーションは
  // 常に新しい Map を代入して $state のリアクティビティを発火させる。
  selected = $state<Map<string, AozoraBook>>(new Map());

  #seq = 0; // 検索シーケンス番号。stale レスポンス破棄と入力キャンセルに使う。
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #page = 1; // 直近に取得済みのページ番号（1始まり）。
  #activeQuery = ""; // 直近の search() に使った検索語（trim 済み）。loadMore() が使う。

  get selectedCount(): number {
    return this.selected.size;
  }

  isSelected(workId: string): boolean {
    return this.selected.has(workId);
  }

  // ダイアログを開く。検索語・結果・選択を初期化し、進行中の検索も失効させる。
  show(): void {
    this.#seq++;
    clearTimeout(this.#debounce);
    this.query = "";
    this.results = [];
    this.selected = new Map();
    this.listState = "start";
    this.hasNext = false;
    this.moreState = "idle";
    this.#page = 1;
    this.#activeQuery = "";
    this.open = true;
  }

  hide(): void {
    this.#seq++;
    clearTimeout(this.#debounce);
    this.open = false;
  }

  // 入力のたびに呼ぶ。空なら即「作品名か作者名を入力してください」表示、
  // そうでなければデバウンス後に検索する。
  onInput(raw: string): void {
    this.query = raw;
    clearTimeout(this.#debounce);
    const q = raw.trim();
    if (!q) {
      this.#seq++; // 進行中の検索を失効させる
      this.results = [];
      this.listState = "start";
      this.hasNext = false;
      this.moreState = "idle";
      this.#page = 1;
      this.#activeQuery = "";
      return;
    }
    this.#debounce = setTimeout(() => void this.search(q), DEBOUNCE_MS);
  }

  // チェックボックス操作。最大 AOZORA_MAX 件まで。上限到達時の新規選択は無視する
  // （UI 側でも未選択チェックボックスを disabled にしている）。
  toggle(book: AozoraBook, checked: boolean): void {
    const next = new Map(this.selected);
    if (checked) {
      if (next.has(book.workId) || next.size >= AOZORA_MAX) return;
      next.set(book.workId, book);
    } else {
      next.delete(book.workId);
    }
    this.selected = next;
  }

  async search(q: string): Promise<void> {
    const seq = ++this.#seq;
    this.results = [];
    this.listState = "searching";
    this.hasNext = false;
    this.moreState = "idle";
    this.#page = 1;
    this.#activeQuery = q;
    try {
      const res = await fetch(`/api/books?q=${encodeURIComponent(q)}&page=1&limit=${AOZORA_FETCH_LIMIT}`);
      if (seq !== this.#seq) return; // 新しい検索・入力・開閉に取って代わられた
      if (!res.ok) {
        this.listState = "fail";
        return;
      }
      const body = await res.json().catch(() => null) as BooksResponse | null;
      if (seq !== this.#seq) return;
      const books = Array.isArray(body?.books) ? (body.books as AozoraBook[]) : [];
      this.results = books;
      this.hasNext = body?.hasNext === true;
      this.listState = books.length ? "results" : "empty";
    } catch {
      if (seq !== this.#seq) return;
      this.listState = "fail";
    }
  }

  // 「もっと読み込む」。次ページを取得して results に追記する。二重発火・
  // hasNext===false・moreState==="loading" 中は何もしない。検索語が変わって
  // いた場合（#seq が進んでいた場合）は結果を破棄する（stale レスポンス対策）。
  async loadMore(): Promise<void> {
    if (this.moreState === "loading" || !this.hasNext || this.listState !== "results") return;
    const seq = this.#seq;
    const q = this.#activeQuery;
    const nextPage = this.#page + 1;
    this.moreState = "loading";
    try {
      const res = await fetch(`/api/books?q=${encodeURIComponent(q)}&page=${nextPage}&limit=${AOZORA_FETCH_LIMIT}`);
      if (seq !== this.#seq) return; // 新しい検索・入力・開閉に取って代わられた
      if (!res.ok) {
        this.moreState = "fail";
        return;
      }
      const body = await res.json().catch(() => null) as BooksResponse | null;
      if (seq !== this.#seq) return;
      const books = Array.isArray(body?.books) ? (body.books as AozoraBook[]) : [];
      // ページ境界の保険: サーバーから重複が返っても workId の key 重複で
      // Svelte がクラッシュしないよう、追記前に既存分と重複排除する。
      const known = new Set(this.results.map((b) => b.workId));
      const fresh = books.filter((b) => !known.has(b.workId));
      this.results = [...this.results, ...fresh];
      this.hasNext = body?.hasNext === true;
      this.#page = nextPage;
      this.moreState = "idle";
    } catch {
      if (seq !== this.#seq) return;
      this.moreState = "fail";
    }
  }
}

export const aozora = new AozoraDialog();
