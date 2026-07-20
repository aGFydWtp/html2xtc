// SPDX-License-Identifier: AGPL-3.0-or-later
// 青空文庫ダイアログの検索・選択状態。検索は 350ms デバウンスで自前 API
// GET /api/books?q= を叩き、検索シーケンス番号で stale レスポンスを破棄する。
// 開くたびに show() で検索・選択状態を全てリセットする。

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

export const AOZORA_MAX = 5;
const DEBOUNCE_MS = 350;

interface BooksResponse {
  books?: unknown;
}

class AozoraDialog {
  open = $state(false);
  query = $state("");
  results = $state<AozoraBook[]>([]);
  listState = $state<AozoraListState>("start");
  // workId -> book。選択順の保持と重複排除を Map で行う。ミューテーションは
  // 常に新しい Map を代入して $state のリアクティビティを発火させる。
  selected = $state<Map<string, AozoraBook>>(new Map());

  #seq = 0; // 検索シーケンス番号。stale レスポンス破棄と入力キャンセルに使う。
  #debounce: ReturnType<typeof setTimeout> | undefined;

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
    try {
      const res = await fetch(`/api/books?q=${encodeURIComponent(q)}`);
      if (seq !== this.#seq) return; // 新しい検索・入力・開閉に取って代わられた
      if (!res.ok) {
        this.listState = "fail";
        return;
      }
      const body = await res.json().catch(() => null) as BooksResponse | null;
      if (seq !== this.#seq) return;
      const books = Array.isArray(body?.books) ? (body.books as AozoraBook[]) : [];
      this.results = books;
      this.listState = books.length ? "results" : "empty";
    } catch {
      if (seq !== this.#seq) return;
      this.listState = "fail";
    }
  }
}

export const aozora = new AozoraDialog();
