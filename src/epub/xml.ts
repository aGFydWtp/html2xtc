// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { DOMParser } from "linkedom";

/**
 * Shared XML parsing plumbing for container.ts/opf.ts/navigation.ts.
 *
 * linkedom's DOMParser is used with the "text/xml" MIME type (not
 * "application/xml", which its own .d.ts doesn't accept, and not
 * parseHTML/"text/html", which applies HTML5 parsing rules — verified
 * empirically that this silently auto-closes an EPUB3
 * `<meta property="...">value</meta>` as an HTML5 void element and drops
 * "value" as a sibling text node, corrupting rendition:layout detection).
 *
 * linkedom's own exported Element/Document types don't line up cleanly with
 * what querySelectorAll/getAttribute/textContent/parentElement actually
 * return at the .d.ts level (verified via `npx tsc --noEmit`: mixing
 * linkedom's "Element" import with its DOMParser output produces "NodeStruct
 * is not assignable to Element" and "does not exist on type Element"
 * errors) — XmlElement/XmlDocument below is a minimal structural type built
 * from what this codebase actually calls, and every DOMParser result is
 * cast to it exactly once, here, rather than fighting individual mismatches
 * at each call site across three files.
 */

export interface XmlElement {
  tagName: string;
  getAttribute(name: string): string | null;
  textContent: string | null;
  parentElement: XmlElement | null;
  /** linkedom's querySelectorAll returns a genuine (subclassed) Array, not a plain NodeList — .filter()/.map() work directly (verified). */
  querySelectorAll(selector: string): XmlElement[];
}

export interface XmlDocument {
  documentElement: XmlElement | null;
}

/** Parses `xml` as real XML (never HTML5 rules). Returns documentElement: null on unparseable input rather than throwing (matches linkedom's own DOMParser behavior). */
export function parseXmlDocument(xml: string): XmlDocument {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as XmlDocument;
}

/** Namespace-agnostic tag matching: strips any "dc:"/"opf:"/"epub:"-style prefix that linkedom's DOMParser preserves verbatim in tagName. */
export function localName(tagName: string): string {
  const idx = tagName.indexOf(":");
  return (idx === -1 ? tagName : tagName.slice(idx + 1)).toLowerCase();
}

/** Every descendant of `root` whose local name matches, document order. */
export function elementsByLocalName(root: XmlElement, name: string): XmlElement[] {
  return root.querySelectorAll("*").filter((el) => localName(el.tagName) === name);
}

export function firstByLocalName(root: XmlElement, name: string): XmlElement | undefined {
  return elementsByLocalName(root, name)[0];
}
