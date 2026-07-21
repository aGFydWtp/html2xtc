// SPDX-License-Identifier: AGPL-3.0-or-later
// @simplewebauthn/browser の薄いラッパー。サーバー（src/auth/webauthn.ts）が
// 返す options は @simplewebauthn/server の generateRegistrationOptions() /
// generateAuthenticationOptions() の戻り値そのままで、@simplewebauthn/browser
// v13 の startRegistration/startAuthentication へ `{ optionsJSON }` として
// 渡せる形式になっている。

import {
  browserSupportsWebAuthn,
  startAuthentication as browserStartAuthentication,
  startRegistration as browserStartRegistration,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

export function startRegistration(optionsJSON: unknown): Promise<RegistrationResponseJSON> {
  return browserStartRegistration({ optionsJSON: optionsJSON as PublicKeyCredentialCreationOptionsJSON });
}

export function startAuthentication(optionsJSON: unknown): Promise<AuthenticationResponseJSON> {
  return browserStartAuthentication({ optionsJSON: optionsJSON as PublicKeyCredentialRequestOptionsJSON });
}
