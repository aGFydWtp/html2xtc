// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { genericAdapter } from "./generic";
import { memlaneAdapter } from "./memlane";
import type { OpdsProvider, OpdsProviderAdapter } from "../types";

export { genericAdapter } from "./generic";
export { memlaneAdapter } from "./memlane";

/**
 * Resolves the adapter for a given provider (spec §6: "プロバイダー名だけで
 * 挙動を大きく分岐させない。原則としてgeneric実装を使い、実サービス差異が
 * 確認されたときだけアダプターで上書きする"). Every provider other than
 * memlane falls back to genericAdapter today — calibre/calibre_web/kavita/
 * other are accepted provider values (spec §6's OpdsProvider union) but none
 * has a confirmed deviation yet, so none has its own adapter file.
 */
export function resolveOpdsProviderAdapter(provider: OpdsProvider): OpdsProviderAdapter {
  return provider === "memlane" ? memlaneAdapter : genericAdapter;
}
